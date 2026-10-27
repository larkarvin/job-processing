'use strict';

/**
 * llm-sync.js
 *
 * Single-pass LLM enrichment using the configured provider.
 * Unlike batch-submit + batch-poll (which are split for async providers),
 * this script processes everything in one run — ideal for the claude-cli
 * provider which resolves synchronously.
 *
 * Usage:
 *   node llm-sync.js
 *
 * Or via cron after the crawler:
 *   30 7 * * * cd /var/www/job-processing && node llm-sync.js >> /var/log/llm-sync.log 2>&1
 *
 * Works with any provider. For async providers (claude, openai) it still
 * works but blocks until the batch completes — use batch-submit + batch-poll
 * instead for those if you don't want to wait.
 */

require('dotenv').config();
const mysql    = require('mysql2/promise');
const provider = require(`./providers/${process.env.LLM_PROVIDER || 'claude-cli'}`);

const SYNC_BATCH_SIZE = parseInt(process.env.SYNC_BATCH_SIZE || '50', 10);
const MAX_BATCHES     = parseInt(process.env.MAX_BATCHES     || '0',  10); // 0 = unlimited

// ── Logger ────────────────────────────────────────────────────────────────────
const LEVELS      = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LVL = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

function log(level, source, event, extra = {}) {
  if ((LEVELS[level] ?? 0) < CURRENT_LVL) return;
  const line = JSON.stringify({ level, source, event, timestamp: new Date().toISOString(), ...extra });
  if (level === 'error') process.stderr.write(line + '\n');
  else                   process.stdout.write(line + '\n');
}
const logger = {
  info:  (s, e, x = {}) => log('info',  s, e, x),
  warn:  (s, e, x = {}) => log('warn',  s, e, x),
  error: (s, e, x = {}) => log('error', s, e, x),
};

// ── Database ──────────────────────────────────────────────────────────────────
function createPool() {
  return mysql.createPool({
    host:            process.env.DB_HOST     || '127.0.0.1',
    port:            parseInt(process.env.DB_PORT || '3306', 10),
    user:            process.env.DB_USER     || 'root',
    password:        process.env.DB_PASSWORD || '',
    database:        process.env.DB_NAME     || '',
    connectionLimit: 5,
    timezone:        'Z',
  });
}

// ── Write a single enriched result back to processed_jobs ─────────────────────
async function writeResult(pool, id, item) {
  if (item.error || !item.result) {
    logger.warn('llm-sync', 'job_failed', { id, error: item.error });
    return false;
  }

  // Merge LLM result over existing rules result — LLM wins on non-null fields
  const [rows] = await pool.execute('SELECT `json` FROM processed_jobs WHERE id = ?', [id]);
  let base = {};
  try { base = JSON.parse(rows[0]?.json || '{}'); } catch { /* ignore */ }

  const r = item.result;
  const merged = {
    ...base,
    ...Object.fromEntries(
      Object.entries(r).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))
    ),
    needs_llm_processing: false,
    _llm_processed:       true,
    _llm_provider:        provider.name,
  };

  const eligibleInt = merged.eligible == null ? null : (merged.eligible ? 1 : 0);

  await pool.execute(
    `UPDATE processed_jobs
     SET eligible              = ?,
         posted_at             = ?,
         needs_more_processing = 0,
         llm_parsed_at         = NOW(),
         \`json\`              = ?
     WHERE id = ?`,
    [eligibleInt, merged.posted_at || null, JSON.stringify(merged), id]
  );

  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('llm-sync', 'start', { provider: provider.name, SYNC_BATCH_SIZE });

  const pool = createPool();

  let totalOk = 0, totalFailed = 0, batchNum = 0;

  while (true) {
    const [jobs] = await pool.query(
      `SELECT pj.id, rj.description AS raw_text
       FROM processed_jobs pj
       JOIN raw_jobs rj ON rj.id = pj.id
       WHERE pj.needs_more_processing = 1
         AND pj.llm_batch_id IS NULL
       ORDER BY pj.id ASC
       LIMIT ${SYNC_BATCH_SIZE}`
    );

    if (jobs.length === 0) break;

    batchNum++;
    logger.info('llm-sync', 'batch_start', { batchNum, count: jobs.length });

    const requests = jobs.map(j => ({ custom_id: String(j.id), jobText: j.raw_text || '' }));

    // Submit (CLI: processes inline; API: submits async batch and waits)
    let externalId;
    try {
      externalId = await provider.submitBatch(requests);
    } catch (err) {
      logger.error('llm-sync', 'submit_failed', { batchNum, error: err.message });
      break;
    }

    // Poll until done
    let status = 'pending';
    while (status === 'pending') {
      status = await provider.pollBatch(externalId);
      if (status === 'pending') {
        logger.info('llm-sync', 'batch_pending', { externalId });
        await new Promise(r => setTimeout(r, 15_000)); // wait 15s before re-checking
      }
    }

    if (status === 'failed') {
      logger.error('llm-sync', 'batch_failed', { externalId });
      break;
    }

    const results = await provider.retrieveResults(externalId);

    let ok = 0, failed = 0;
    for (const item of results) {
      const id = parseInt(item.custom_id, 10);
      const success = await writeResult(pool, id, item);
      if (success) ok++; else failed++;
    }

    totalOk     += ok;
    totalFailed += failed;
    logger.info('llm-sync', 'batch_done', { batchNum, ok, failed, totalOk, totalFailed });

    if (MAX_BATCHES > 0 && batchNum >= MAX_BATCHES) break;
  }

  logger.info('llm-sync', 'done', { totalOk, totalFailed });
  await pool.end();
}

main().catch(err => {
  log('error', 'llm-sync', 'unhandled_error', { error: err.message, stack: err.stack });
  process.exit(1);
});
