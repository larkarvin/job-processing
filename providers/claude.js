'use strict';

/**
 * Claude (Anthropic) batch provider.
 *
 * Implements the LLM provider interface:
 *   submitBatch(requests)   → Promise<externalBatchId: string>
 *   pollBatch(externalId)   → Promise<'pending' | 'complete' | 'failed'>
 *   retrieveResults(id)     → Promise<Array<{ custom_id, result, error }>>
 *
 * To add a new provider (OpenAI, Gemini, etc.) create a sibling file that
 * exports the same three methods, then set LLM_PROVIDER in .env.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL         = process.env.CLAUDE_BATCH_MODEL || 'claude-haiku-4-5';
const MAX_TEXT_CHARS = 12_000; // ~3 000 tokens — more than enough for any job posting

// Stable system prompt — same across all requests in every batch.
// Marked ephemeral so Anthropic caches it within the batch, cutting input cost.
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

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// ── Public interface ──────────────────────────────────────────────────────────

/**
 * @param {Array<{ custom_id: string, jobText: string }>} requests
 * @returns {Promise<string>} Anthropic batch ID (e.g. "msgbatch_...")
 */
async function submitBatch(requests) {
  const client = getClient();

  const batchRequests = requests.map(r => ({
    custom_id: r.custom_id,
    params: {
      model:      MODEL,
      max_tokens: 1024,
      system: [{
        type:          'text',
        text:          SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }, // cached within the batch → cheaper input
      }],
      messages: [{
        role:    'user',
        content: (r.jobText || '').slice(0, MAX_TEXT_CHARS),
      }],
    },
  }));

  const batch = await client.messages.batches.create({ requests: batchRequests });
  return batch.id;
}

/**
 * @param {string} externalId  Anthropic batch ID
 * @returns {Promise<'pending'|'complete'|'failed'>}
 */
async function pollBatch(externalId) {
  const client  = getClient();
  const batch   = await client.messages.batches.retrieve(externalId);

  if (batch.processing_status === 'ended')     return 'complete';
  if (batch.processing_status === 'canceling') return 'failed';
  return 'pending';
}

/**
 * @param {string} externalId  Anthropic batch ID (must be in 'ended' state)
 * @returns {Promise<Array<{ custom_id: string, result: object|null, error: string|null }>>}
 */
async function retrieveResults(externalId) {
  const client  = getClient();
  const results = [];

  for await (const item of await client.messages.batches.results(externalId)) {
    if (item.result.type === 'succeeded') {
      const text = item.result.message.content.find(b => b.type === 'text')?.text || '';
      try {
        // Strip accidental markdown fences before parsing
        const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        results.push({ custom_id: item.custom_id, result: JSON.parse(clean), error: null });
      } catch {
        results.push({ custom_id: item.custom_id, result: null, error: 'json_parse_error' });
      }
    } else {
      results.push({ custom_id: item.custom_id, result: null, error: item.result.type });
    }
  }

  return results;
}

module.exports = { name: 'claude', submitBatch, pollBatch, retrieveResults };
