'use strict';

/**
 * batch-poll.js
 *
 * Checks all pending LLM batches, retrieves results for completed ones,
 * and writes enriched data back to processed_jobs.
 *
 * Run periodically until all batches are resolved:
 *   node batch-poll.js
 *
 * Or via cron (every 15 minutes):
 *   0,15,30,45 * * * * cd /var/www/job-processing && node batch-poll.js
 *
 * Batches typically complete within minutes to ~1 hour.
 */

require('dotenv').config();
const mysql    = require('mysql2/promise');
const provider = require(`./providers/${process.env.LLM_PROVIDER || 'claude'}`);

// ── Logger ────────────────────────────────────────────────────────────────────
const LEVELS       = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LVL  = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

function log(level, source, event, extra = {}) {
  if ((LEVELS[level] ?? 0) < CURRENT_LVL) return;
  const line = JSON.stringify({ level, source, event, timestamp: new Date().toISOString(), ...extra });
  if (level === 'error') process.stderr.write(line + '\n');
  else                   process.stdout.write(line + '\n');
}
const logger = {
  debug: (s, e, x) => log('debug', s, e, x),
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

// ── Result writer ─────────────────────────────────────────────────────────────

async function writeResults(pool, results, batchId) {
  let ok = 0, failed = 0;

  for (const item of results) {
    const id = parseInt(item.custom_id, 10);

    if (item.error || !item.result) {
      // LLM failed for this job — clear the batch tag so it can be retried
      await pool.execute(
        `UPDATE processed_jobs
         SET needs_more_processing = 1, llm_batch_id = NULL
         WHERE id = ?`,
        [id]
      );
      logger.warn('batch-poll', 'job_failed', { id, error: item.error });
      failed++;
      continue;
    }

    const r = item.result;

    // Merge LLM result with any fields it left null → fall back to what rules
    // already stored in the json column (avoids overwriting good data with null)
    const [existing] = await pool.execute(
      'SELECT `json` FROM processed_jobs WHERE id = ?', [id]
    );
    let base = {};
    try { base = JSON.parse(existing[0]?.json || '{}'); } catch { /* ignore */ }

    const merged = {
      ...base,
      ...Object.fromEntries(
        Object.entries(r).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))
      ),
      needs_llm_processing: false,
      _llm_processed:       true,
      _llm_provider:        provider.name,
    };

    const eligibleInt = merged.eligible === null || merged.eligible === undefined
      ? null
      : (merged.eligible ? 1 : 0);

    await pool.execute(
      `UPDATE processed_jobs
       SET eligible              = ?,
           posted_at             = ?,
           needs_more_processing = 0,
           llm_parsed_at         = NOW(),
           \`json\`              = ?
       WHERE id = ?`,
      [
        eligibleInt,
        merged.posted_at || null,
        JSON.stringify(merged),
        id,
      ]
    );

    logger.debug('batch-poll', 'job_written', { id, eligible: merged.eligible });
    ok++;
  }

  return { ok, failed };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('batch-poll', 'start', { provider: provider.name });

  const pool = createPool();

  // Find all pending batches for this provider
  const [batches] = await pool.execute(
    `SELECT id, external_id, job_count
     FROM llm_batches
     WHERE provider = ? AND status = 'pending'
     ORDER BY submitted_at ASC`,
    [provider.name]
  );

  if (batches.length === 0) {
    logger.info('batch-poll', 'no_pending_batches', {});
    await pool.end();
    return;
  }

  logger.info('batch-poll', 'checking_batches', { count: batches.length });

  let totalOk = 0, totalFailed = 0;

  for (const batch of batches) {
    const { id: batchId, external_id: externalId, job_count: jobCount } = batch;

    let status;
    try {
      status = await provider.pollBatch(externalId);
    } catch (err) {
      logger.error('batch-poll', 'poll_error', { batchId, externalId, error: err.message });
      continue;
    }

    logger.info('batch-poll', 'batch_status', { batchId, externalId, status, jobCount });

    if (status === 'pending') continue;

    if (status === 'failed') {
      // Mark batch failed; free jobs for re-submission
      await pool.execute(
        `UPDATE llm_batches SET status = 'failed', completed_at = NOW() WHERE id = ?`,
        [batchId]
      );
      await pool.execute(
        `UPDATE processed_jobs
         SET needs_more_processing = 1, llm_batch_id = NULL
         WHERE llm_batch_id = ?`,
        [batchId]
      );
      logger.warn('batch-poll', 'batch_failed', { batchId, externalId });
      continue;
    }

    // status === 'complete' — retrieve and write results
    let results;
    try {
      results = await provider.retrieveResults(externalId);
    } catch (err) {
      logger.error('batch-poll', 'retrieve_error', { batchId, externalId, error: err.message });
      continue;
    }

    const { ok, failed } = await writeResults(pool, results, batchId);
    totalOk     += ok;
    totalFailed += failed;

    await pool.execute(
      `UPDATE llm_batches SET status = 'complete', completed_at = NOW() WHERE id = ?`,
      [batchId]
    );

    logger.info('batch-poll', 'batch_complete', { batchId, externalId, ok, failed });
  }

  logger.info('batch-poll', 'done', { totalOk, totalFailed });

  await pool.end();
}

main().catch(err => {
  log('error', 'batch-poll', 'unhandled_error', { error: err.message, stack: err.stack });
  process.exit(1);
});
