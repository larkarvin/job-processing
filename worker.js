'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

// ─── 1. CONFIG ───────────────────────────────────────────────────────────────

const BATCH_SIZE     = parseInt(process.env.BATCH_SIZE     || '20',  10);
const ENABLE_LLM     = process.env.ENABLE_LLM !== 'false';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3',   10);
const LOG_LEVEL      = process.env.LOG_LEVEL  || 'info';

// ─── 2. LOGGER ───────────────────────────────────────────────────────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function log(level, source, event, extra = {}) {
  if ((LEVELS[level] ?? 0) < CURRENT_LEVEL) return;
  const line = JSON.stringify({
    level,
    source,
    event,
    timestamp: new Date().toISOString(),
    ...extra,
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

const logger = {
  debug: (s, e, x = {}) => log('debug', s, e, x),
  info:  (s, e, x = {}) => log('info',  s, e, x),
  warn:  (s, e, x = {}) => log('warn',  s, e, x),
  error: (s, e, x = {}) => log('error', s, e, x),
};

// ─── 3. DATABASE ─────────────────────────────────────────────────────────────

function createPool() {
  return mysql.createPool({
    host:               process.env.DB_HOST     || '127.0.0.1',
    port:               parseInt(process.env.DB_PORT || '3306', 10),
    user:               process.env.DB_USER     || 'root',
    password:           process.env.DB_PASSWORD || '',
    database:           process.env.DB_NAME     || '',
    waitForConnections: true,
    connectionLimit:    5,
    timezone:           'Z',
  });
}

// ─── 4. BATCH FETCHING ───────────────────────────────────────────────────────
//
// Three-step locking pattern:
//   A) SELECT ... FOR UPDATE SKIP LOCKED inside a transaction to claim IDs
//   B) UPDATE processed_at = NOW() immediately to release lock intent fast
//   C) COMMIT — then fetch full row data (LONGTEXT) outside the lock window
//
// This keeps the InnoDB row lock window under ~5ms regardless of batch size
// and allows multiple concurrent worker processes to drain the queue safely.

async function fetchBatch(pool) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Use conn.query() (text protocol) — mysql2 prepared statements do not
    // support FOR UPDATE SKIP LOCKED; safe here because BATCH_SIZE is a
    // validated integer constant, not user input.
    const [rows] = await conn.query(
      `SELECT id FROM raw_jobs
       WHERE processed_at IS NULL
       ORDER BY id ASC
       LIMIT ${BATCH_SIZE}
       FOR UPDATE SKIP LOCKED`
    );

    if (rows.length === 0) {
      await conn.rollback();
      return [];
    }

    const ids          = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(', ');

    await conn.execute(
      `UPDATE raw_jobs SET processed_at = NOW() WHERE id IN (${placeholders})`,
      ids
    );

    await conn.commit();

    // Fetch full data (including description LONGTEXT) outside the lock window.
    // scraped_at is used as a fallback when no posted date is found in the text.
    const [jobs] = await conn.execute(
      `SELECT id, hash, url, source, title, company, location, geo_region,
              description AS raw_text, tags, scraped_at
       FROM raw_jobs WHERE id IN (${placeholders})`,
      ids
    );

    return jobs;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─── 5. PER-SOURCE PARSERS ───────────────────────────────────────────────────

const PARSERS = {
  weworkremotely:       require('./parsers/weworkremotely'),
  greenhouse_remotecom: require('./parsers/greenhouse_remotecom'),
  lever_outsourcedstaff:require('./parsers/greenhouse_remotecom'), // same HTML structure
  remoteok:             require('./parsers/remoteok'),
  remotive:             require('./parsers/remotive'),
};
const defaultParser = require('./parsers/default');
const { detectInternship, stripHtml } = require('./parsers/base');

function getParser(source) {
  return PARSERS[(source || '').toLowerCase()] || defaultParser;
}

// After parsing, decide whether LLM enrichment is still needed.
// Rules are good at structure — LLM fills in what's genuinely ambiguous.
function needsLLM(result, source) {
  if (!ENABLE_LLM) return false;

  // If eligibility is still unknown after source-aware parsing, LLM can help
  if (result.eligible === null) return true;

  // If we extracted no structured content at all, LLM can do better
  const hasContent = (result.requirements  && result.requirements.length  > 0)
                  || (result.responsibilities && result.responsibilities.length > 0)
                  || (result.skills          && result.skills.length          > 0);
  if (!hasContent) return true;

  // Skills alone (e.g. from category tag) with no requirements AND no
  // responsibilities means the rule-based extraction found no structure —
  // flag for LLM to attempt a proper extraction
  const hasStructure = (result.requirements     && result.requirements.length     > 0)
                    || (result.responsibilities  && result.responsibilities.length > 0);
  if (!hasStructure) return true;

  return false;
}

// ─── 6. LLM (async batch) ────────────────────────────────────────────────────
//
//   node batch-submit.js / llm-sync.js  — submit flagged jobs
//   node batch-poll.js                  — retrieve results
//
// Provider selected by LLM_PROVIDER in .env.

// ─── 7. JOB ORCHESTRATION ────────────────────────────────────────────────────

async function processJob(job, pool) {
  const { id, source } = job;
  const start = Date.now();

  try {
    // tags is stored as a JSON string in MySQL — parse before dispatching
    if (typeof job.tags === 'string') {
      try { job.tags = JSON.parse(job.tags); } catch { job.tags = []; }
    }

    const parse  = getParser(source);
    const result = parse(job);

    // Internships are never eligible regardless of location
    if (detectInternship(job.title, result.summary || '')) {
      result.eligible = false;
      result.eligibility_flags = {
        geo_restricted:             false,
        reason:                     'Internship',
        requires_visa_sponsorship:  false,
        apac_allowed:               false,
        sea_allowed:                false,
      };
    }

    // Short eligible jobs: if plain text (excluding spaces) is ≤ 2000 chars,
    // the content is too thin for structured extraction — copy it all to summary.
    if (result.eligible) {
      // Strip source-specific noise before counting/copying
      let rawForSummary = job.raw_text || '';
      rawForSummary = rawForSummary.replace(/Please\s+mention\s+the\s+word[\s\S]*$/i, '');
      const plain = stripHtml(rawForSummary)
        .replace(/\\n/g, '\n')   // unescape literal \n sequences from raw HTML
        .replace(/\n{3,}/g, '\n\n');  // collapse excessive blank lines
      if (plain.replace(/ /g, '').length <= 3000) {
        result.summary = plain
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0)
          .join('\n');
      }
    }

    // posted_at fallback: use scraped_at if parser found nothing in text
    if (!result.posted_at && job.scraped_at) {
      const dt = job.scraped_at instanceof Date ? job.scraped_at : new Date(job.scraped_at);
      if (!isNaN(dt)) {
        result.posted_at = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
      }
    }

    const useLLM = needsLLM(result, source);
    result.needs_llm_processing = useLLM;

    logger.debug('process_job', 'routing_decision', { id, source, useLLM });

    // eligible stored as TINYINT: null=unknown, 1=yes, 0=no
    const eligibleInt = result.eligible === null || result.eligible === undefined
      ? null
      : (result.eligible ? 1 : 0);

    await pool.execute(
      `INSERT INTO processed_jobs
         (id, raw_id, processed_at, posted_at, eligible, source, synced_at, needs_more_processing, \`json\`)
       VALUES (?, ?, NOW(), ?, ?, ?, NULL, ?, ?)
       ON DUPLICATE KEY UPDATE
         raw_id                = VALUES(raw_id),
         processed_at          = NOW(),
         posted_at             = VALUES(posted_at),
         eligible              = VALUES(eligible),
         needs_more_processing = VALUES(needs_more_processing),
         \`json\`              = VALUES(\`json\`)`,
      [id, id, result.posted_at || null, eligibleInt, source || null, useLLM ? 1 : 0, JSON.stringify(result)]
    );

    logger.info('process_job', 'job_complete', {
      id,
      source,
      useLLM,
      eligible:   result.eligible,
      is_va_role: result.is_va_role,
      posted_at:  result.posted_at,
      durationMs: Date.now() - start,
    });

    return { id, status: 'ok' };
  } catch (err) {
    logger.error('process_job', 'job_failed', {
      id,
      source,
      error:      err.message,
      durationMs: Date.now() - start,
    });
    return { id, status: 'error', error: err.message };
  }
}

// ─── 9. BATCH PROCESSING ─────────────────────────────────────────────────────

async function processBatch(jobs, pool) {
  const stats = { total: jobs.length, ok: 0, error: 0 };

  for (let i = 0; i < jobs.length; i += MAX_CONCURRENT) {
    const chunk   = jobs.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.allSettled(
      chunk.map(job => processJob(job, pool))
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.status === 'ok') {
        stats.ok++;
      } else {
        stats.error++;
        if (r.status === 'rejected') {
          logger.error('batch', 'promise_rejected', { reason: r.reason?.message });
        }
      }
    }
  }

  return stats;
}

// ─── 10. POST-PROCESS DEDUPLICATION ─────────────────────────────────────────
//
// Some sources (greenhouse_remotecom, lever_outsourcedstaff) post the same job
// multiple times under different "Remote-<Region>" location tags.  After all
// batches complete we collapse each (title, company, source) group down to one
// row: prefer eligible=1, then eligible=0, then NULL; break ties with lowest id.
//
// We only touch processed_jobs — raw_jobs rows keep their processed_at stamps
// so they are never re-fetched.

async function deduplicateByTitleCompany(pool, source) {
  // One DELETE pass: for every processed_jobs row, remove it if a strictly
  // better-or-equal sibling with a lower id exists in the same group.
  //
  // "Better" = higher COALESCE(eligible, -1): 1 > 0 > -1 (NULL)
  // "Equal"  = same eligible value but lower id exists → this one loses
  //
  // MySQL does not allow a DELETE on a table that is also referenced in a
  // sub-SELECT, so we wrap the subquery in a derived table.
  const [result] = await pool.execute(
    `DELETE p
     FROM processed_jobs p
     JOIN (
       SELECT id FROM processed_jobs p_inner
       WHERE p_inner.source = ?
         AND EXISTS (
           SELECT 1
           FROM processed_jobs p2
           WHERE p2.source = ?
             AND JSON_UNQUOTE(JSON_EXTRACT(p2.json, '$.title'))   = JSON_UNQUOTE(JSON_EXTRACT(p_inner.json, '$.title'))
             AND JSON_UNQUOTE(JSON_EXTRACT(p2.json, '$.company')) = JSON_UNQUOTE(JSON_EXTRACT(p_inner.json, '$.company'))
             AND (
               COALESCE(p2.eligible, -1) > COALESCE(p_inner.eligible, -1)
               OR (
                 COALESCE(p2.eligible, -1) = COALESCE(p_inner.eligible, -1)
                 AND p2.id < p_inner.id
               )
             )
         )
     ) AS to_delete ON p.id = to_delete.id`,
    [source, source]
  );

  logger.info('worker', 'dedup_complete', { source, deleted: result.affectedRows });
  return result.affectedRows;
}

// ─── 11. MAIN DRAIN LOOP ─────────────────────────────────────────────────────

async function main() {
  logger.info('worker', 'worker_start', {
    BATCH_SIZE,
    ENABLE_LLM,
    MAX_CONCURRENT,
    LOG_LEVEL,
  });

  const pool = createPool();

  // Probe the connection before entering the loop
  try {
    const conn = await pool.getConnection();
    conn.release();
    logger.info('worker', 'db_connected', { database: process.env.DB_NAME });
  } catch (err) {
    logger.error('worker', 'db_connect_failed', { error: err.message });
    process.exit(1);
  }

  let totalProcessed = 0;
  let totalErrors    = 0;
  let batchNum       = 0;

  while (true) {
    batchNum++;
    let jobs;

    try {
      jobs = await fetchBatch(pool);
    } catch (err) {
      logger.error('worker', 'fetch_batch_failed', {
        batchNum,
        error: err.message,
      });
      break;
    }

    if (jobs.length === 0) {
      logger.info('worker', 'no_more_jobs', { batchNum, totalProcessed, totalErrors });
      break;
    }

    logger.info('worker', 'batch_start', { batchNum, count: jobs.length });

    const stats = await processBatch(jobs, pool);
    totalProcessed += stats.ok;
    totalErrors    += stats.error;

    logger.info('worker', 'batch_complete', {
      batchNum,
      total:          stats.total,
      ok:             stats.ok,
      error:          stats.error,
      totalProcessed,
      totalErrors,
    });
  }

  logger.info('worker', 'worker_done', { totalProcessed, totalErrors });

  // Deduplicate sources that emit one listing per geo-region
  for (const src of ['greenhouse_remotecom', 'lever_outsourcedstaff']) {
    try {
      await deduplicateByTitleCompany(pool, src);
    } catch (err) {
      logger.error('worker', 'dedup_failed', { source: src, error: err.message });
    }
  }

  await pool.end();
  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => {
  logger.error('worker', 'unhandled_error', {
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
