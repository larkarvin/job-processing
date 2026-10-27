'use strict';
const {
  stripHtml, extractSection, scaffold,
  detectEligibility, detectRemote, detectVaRole,
  detectTimeTracker, detectSkills, detectSeniority, detectEmploymentType,
  extractPostedAt, extractApplyBefore, extractApplyUrl,
  extractStartDate, extractSalary, buildEligibilityFlags,
} = require('./base');

// Extract key/value pairs from the "Practicals" section:
//   <h2>Practicals</h2><ul><li><strong>Location</strong>: Anywhere in the World</li>...
// Returns { location, start_date, ... } — all values are plain text.
function extractPracticals(html) {
  const hIdx = html.search(/<h[1-3][^>]*>\s*Practicals\s*<\/h[1-3]>/i);
  if (hIdx === -1) return {};

  const after = html.slice(hIdx);
  const listMatch = after.match(/<[uo]l[^>]*>([\s\S]*?)<\/[uo]l>/i);
  if (!listMatch) return {};

  const out = {};
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(listMatch[1])) !== null) {
    const text = stripHtml(m[1]).replace(/\s+/g, ' ').trim();
    const kv = text.match(/^([^:]+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const val = kv[2].trim();
    if (/^location/.test(key))    out.location   = val;
    if (/^start\s*date/.test(key)) out.start_date = val;
  }
  return out;
}

// Determine eligibility from a plain-text location value (from Practicals or job board).
function eligibilityFromText(loc) {
  const l = (loc || '').toLowerCase().replace(/^remote\s*[-–]\s*/i, '').replace(/^remote\s+/i, '').trim();
  if (!l) return null;
  // "Anywhere in the World", "Worldwide", "Global", bare "Anywhere" → open
  // But "Anywhere in EMEA/Europe/US/etc." → that specific region only → restricted
  if (/\banywhere\s+in\s+(the\s+)?world\b/i.test(l))                return true;
  if (/\b(worldwide|global)\b/.test(l) && !/\bin\s+\w/.test(l))     return true;
  if (/^\s*anywhere\s*$/.test(l))                                    return true;
  if (/philippines|southeast[\s\-]?asia|\bsea\b(?:\s|$)/.test(l))   return true;
  if (/^apac$|^asia[\s\-]pacific$/.test(l))                          return true;
  // Any specific region/country (including "Anywhere in EMEA") → restricted
  return false;
}

module.exports = function parse(job) {
  const result    = scaffold(job);
  const html      = job.raw_text || '';
  const plain     = stripHtml(html);
  const tags      = job.tags || [];
  const scrapedAt = job.scraped_at;

  // "Practicals" section is the authoritative source for start date.
  // For eligibility, the job board's Remote-XX category tag comes first —
  // it is explicitly set by the employer and appears at the top of the listing.
  // Practicals.location is used as a fallback when the tag is absent/ambiguous.
  const practicals = extractPracticals(html);

  // Eligibility: job board tag first, then Practicals.location, then text signals
  const eligible =
    eligibilityFromText(job.location) ??
    (practicals.location ? eligibilityFromText(practicals.location) : null) ??
    detectEligibility(plain);

  // Start date: Practicals.start_date first, then free-text extraction
  const practicalStartDate = practicals.start_date
    ? (/asap|as\s+soon\s+as\s+possible/i.test(practicals.start_date) ? 'ASAP'
      : /immediate(?:ly)?/i.test(practicals.start_date) ? 'Immediate'
      : practicals.start_date.slice(0, 50))
    : null;

  const { remote, remote_type } = detectRemote(plain, job.location);
  const { is_va_role, va_specialization } = detectVaRole(plain, job.title);
  const { time_tracker_required, time_tracker_tools } = detectTimeTracker(plain);

  const requirements     = extractSection(html, /requirements?|qualifications?|what you bring|what you.?ll need/i);
  const responsibilities = extractSection(html, /responsibilities?|what this job|what you.?ll do|the role/i);

  // job.location (Remote-XX tag) is primary; Practicals.location as fallback
  const flagLocation = job.location || practicals.location;

  result.remote               = remote;
  result.remote_type          = remote_type || 'remote'; // greenhouse_remotecom is always remote
  result.eligible             = eligible;
  result.is_va_role           = is_va_role;
  result.va_specialization    = va_specialization;
  result.time_tracker_required = time_tracker_required;
  result.time_tracker_tools   = time_tracker_tools;
  result.seniority            = detectSeniority(plain, job.title);
  result.employment_type      = detectEmploymentType(plain);
  result.skills               = detectSkills(plain, tags);
  result.requirements         = requirements;
  result.responsibilities     = responsibilities;
  result.salary               = extractSalary(html, plain);
  result.apply_url            = extractApplyUrl(html, job.url);
  result.apply_before         = extractApplyBefore(plain);
  result.start_date           = practicalStartDate || extractStartDate(plain);
  result.posted_at            = extractPostedAt(plain, scrapedAt);
  result.eligibility_flags    = buildEligibilityFlags(result.eligible, flagLocation, plain);

  return result;
};
