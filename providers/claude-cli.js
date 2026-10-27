'use strict';

/**
 * Claude CLI provider — uses the locally authenticated `claude` CLI.
 * No API key or billing required; uses your Claude.ai subscription.
 *
 * Implements the same LLM provider interface as providers/claude.js:
 *   submitBatch(requests)  → fake batchId (results processed inline)
 *   pollBatch(batchId)     → always 'complete' (synchronous)
 *   retrieveResults(id)    → results stored in memory during submitBatch
 *
 * Because the CLI is synchronous, submitBatch processes jobs immediately.
 * The batch infrastructure (llm_batches table, batch-poll.js) still works —
 * it just resolves in the same run.
 *
 * Switch back to the API provider any time:
 *   LLM_PROVIDER=claude   in .env
 */

const { execFileSync } = require('child_process');

const MAX_TEXT_CHARS = 12_000;
const CALL_TIMEOUT_MS = parseInt(process.env.CLI_TIMEOUT_MS || '60000', 10);

const SYSTEM_PROMPT = `\
You are a job listing data extractor. Given raw job posting text, extract structured data \
and return ONLY a valid JSON object — no prose, no markdown fences, no extra keys.

Return exactly this schema (null for missing scalar fields, [] for missing arrays):
{
  "title": "<string|null>",
  "company": "<string|null>",
  "location": "<string|null>",
  "remote": "<boolean|null>",
  "remote_type": "<fully_remote|hybrid|remote|null>",
  "eligible": "<boolean|null — true=open to PH/SEA/APAC/global, false=US-only, null=unclear>",
  "is_va_role": "<boolean|null>",
  "va_specialization": "<admin_va|social_media_va|bookkeeping_va|real_estate_va|customer_support_va|research_va|general_va|null>",
  "time_tracker_required": "<boolean|null>",
  "time_tracker_tools": ["<string>"],
  "seniority": "<entry|mid|senior|lead|executive|null>",
  "employment_type": "<full_time|part_time|contract|freelance|null>",
  "salary": "<string|null>",
  "requirements": ["<string>"],
  "responsibilities": ["<string>"],
  "skills": ["<string>"],
  "industries": ["<string>"],
  "summary": "<1-2 sentence summary|null>",
  "apply_url": "<string|null>",
  "posted_at": "<YYYY-MM-DD if found in text|null>"
}`;

// In-memory store: batchId → results[]
// Lives for the duration of a single llm-sync.js run.
const _store = new Map();

function callCLI(jobText) {
  const text = (jobText || '').slice(0, MAX_TEXT_CHARS);

  // Strip ANTHROPIC_API_KEY so the CLI uses OAuth (not the placeholder from .env)
  const { ANTHROPIC_API_KEY: _dropped, ...safeEnv } = process.env;

  const raw = execFileSync('claude', [
    '-p', text,
    '--output-format', 'json',
    '--system-prompt', SYSTEM_PROMPT,
  ], {
    timeout:  CALL_TIMEOUT_MS,
    encoding: 'utf8',
    env:      safeEnv,
    // Suppress stderr so logs stay clean; errors surface via thrown exceptions
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  const wrapper = JSON.parse(raw);
  if (wrapper.is_error) throw new Error(wrapper.result || 'claude CLI error');

  const resp = wrapper.result || '';
  // Extract the JSON object/array — find first { or [ and last matching } or ]
  const start = resp.search(/[{[]/);
  if (start === -1) throw new Error('No JSON found in CLI response');
  const opener = resp[start];
  const closer = opener === '{' ? '}' : ']';
  const end = resp.lastIndexOf(closer);
  if (end === -1) throw new Error('No closing bracket in CLI response');
  const clean = resp.slice(start, end + 1);

  return JSON.parse(clean);
}

// ── Provider interface ────────────────────────────────────────────────────────

async function submitBatch(requests) {
  const results = [];

  for (const r of requests) {
    try {
      const result = callCLI(r.jobText);
      results.push({ custom_id: r.custom_id, result, error: null });
    } catch (err) {
      results.push({ custom_id: r.custom_id, result: null, error: err.message.slice(0, 200) });
    }
  }

  const batchId = `cli-${Date.now()}`;
  _store.set(batchId, results);
  return batchId;
}

async function pollBatch(externalId) {
  return _store.has(externalId) ? 'complete' : 'failed';
}

async function retrieveResults(externalId) {
  const results = _store.get(externalId) || [];
  _store.delete(externalId);
  return results;
}

module.exports = { name: 'claude-cli', submitBatch, pollBatch, retrieveResults };
