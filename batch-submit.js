'use strict';

/**
 * batch-submit.js
 *
 * Picks up all processed_jobs rows where needs_more_processing=1 and
 * llm_batch_id IS NULL, submits them as a single batch to the configured
 * LLM provider, and records the external batch ID.
 *
 * Run after worker.js:
 *   node batch-submit.js
 *
 * Or via cron (e.g. 5 minutes after the crawler):
 *   5 * * * * cd /var/www/job-processing && node batch-submit.js
 */

require('dotenv').config();
const mysql    = require('mysql2/promise');
const provider = require(`./providers/${process.env.LLM_PROVIDER || 'claude'}`);

const SUBMIT_BATCH_SIZE = parseInt(process.env.SUBMIT_BATCH_SIZE || '500', 10);

// ── Logger (mirrors worker.js) ────────────────────────────────────────────────
const LEVELS       = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LVL  = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

function log(level, source, event, extra = {}) {
  if ((LEVELS[level] ?? 0) < CURRENT_LVL) return;
  const line = JSON.stringify({ level, source, event, timestamp: new Date().toISOString(), ...extra });
  if (level === 'error') process.stderr.write(line + '\n');
  else                   process.stdout.write(line + '\n');
}
const logger = {
  info:  (s, e, x) => log('info',  s, e, x),
  warn:  (s, e, x) => log('warn',  s, e, x),
  error: (s, e, x) => log('error', s, e, x),
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('batch-submit', 'start', { provider: provider.name, SUBMIT_BATCH_SIZE });

  const pool = createPool();

  // Fetch jobs that need LLM but haven't been submitted to a batch yet.
  // We join raw_jobs to get the original text (processed_jobs only stores the result).
  const [jobs] = await pool.execute(
    `SELECT pj.id, rj.description AS raw_text, rj.source
     FROM processed_jobs pj
     JOIN raw_jobs rj ON rj.id = pj.id
     WHERE pj.needs_more_processing = 1
       AND pj.llm_batch_id IS NULL
     LIMIT ?`,
    [SUBMIT_BATCH_SIZE]
  );

  if (jobs.length === 0) {
    logger.info('batch-submit', 'nothing_to_submit', {});
    await pool.end();
    return;
  }

  logger.info('batch-submit', 'submitting', { count: jobs.length, provider: provider.name });

  // Build provider-agnostic request list
  const requests = jobs.map(j => ({
    custom_id: String(j.id),
    jobText:   j.raw_text || '',
  }));

  let externalId;
  try {
    externalId = await provider.submitBatch(requests);
  } catch (err) {
    logger.error('batch-submit', 'submit_failed', { error: err.message });
    await pool.end();
    process.exit(1);
  }

  // Record the batch
  const [batchRow] = await pool.execute(
    `INSERT INTO llm_batches (provider, external_id, status, job_count)
     VALUES (?, ?, 'pending', ?)`,
    [provider.name, externalId, jobs.length]
  );
  const batchId = batchRow.insertId;

  // Tag each processed_jobs row with this batch
  const ids          = jobs.map(j => j.id);
  const placeholders = ids.map(() => '?').join(', ');
  await pool.execute(
    `UPDATE processed_jobs SET llm_batch_id = ? WHERE id IN (${placeholders})`,
    [batchId, ...ids]
  );

  logger.info('batch-submit', 'done', {
    batchId,
    externalId,
    jobCount: jobs.length,
    provider: provider.name,
  });

  await pool.end();
}

main().catch(err => {
  log('error', 'batch-submit', 'unhandled_error', { error: err.message, stack: err.stack });
  process.exit(1);
});
