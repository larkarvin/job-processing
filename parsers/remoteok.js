'use strict';
const {
  stripHtml, extractSection, scaffold,
  detectEligibility, detectRemote, detectVaRole,
  detectTimeTracker, detectSkills, detectSeniority, detectEmploymentType,
  extractPostedAt, extractApplyBefore, extractApplyUrl,
  extractStartDate, extractSalary, buildEligibilityFlags,
} = require('./base');

// remoteok appends a spam-filter line at the end of every listing:
//   "Please mention the word **XYZ** and tag RMjc..."
// Strip it before parsing so it doesn't pollute eligibility or skill signals.
function cleanHtml(html) {
  return html.replace(/Please\s+mention\s+the\s+word[\s\S]*$/i, '');
}

// remoteok job board location field:
//   "Worldwide" / "Anywhere" → eligible
//   "Remote, US" / "United States" → not eligible
//   "Remote" (bare) → unclear
function eligibilityFromLocation(location) {
  const l = (location || '').toLowerCase();
  if (/worldwide|anywhere|global/.test(l))              return true;
  if (/\bus\b|united\s+states|usa|america/.test(l))     return false;
  if (/europe|germany|uk\b|united\s+kingdom|france/.test(l)) return false;
  return null;
}

// Many remoteok listings embed a "Location:" line in the body text, e.g.:
//   "Location: Remote (USA)" or "Location: Worldwide"
// This overrides the job board category since it's written by the employer.
function eligibilityFromBodyLocation(plain) {
  const m = plain.match(/\bLocation\s*[:\-]\s*([^\n]{3,80})/i);
  if (!m) return null;
  const l = m[1].toLowerCase();
  if (/worldwide|anywhere|global/i.test(l))             return true;
  if (/philippines|southeast\s*asia|\bsea\b/i.test(l))  return true;
  if (/apac|asia\s*pacific/i.test(l))                   return true;
  if (/\bus\b|usa|united\s+states/i.test(l))            return false;
  if (/europe|uk\b|germany|france/i.test(l))            return false;
  return null;
}

// remoteok mixes <ul>/<li> lists AND <h4>/<p> paragraph blocks for sections.
// Try list-based extraction first; fall back to grabbing <p> text under the heading.
function extractSectionWithFallback(html, plain, sectionRe) {
  // Try structured list extraction first
  const fromList = extractSection(html, sectionRe);
  if (fromList.length > 0) return fromList;

  // Fallback: plain-text paragraph extraction
  // Find the heading line, then collect non-empty lines until the next heading
  const NEXT_HEADING = /\n(?:about|responsibilities?|requirements?|qualifications?|what you|how you|why us|benefits?|compensation|salary|location|role|job title|apply)/i;
  const m = plain.match(new RegExp('(?:' + sectionRe.source + ')[:\\s]*\\n([\\s\\S]*?)(?=' + NEXT_HEADING.source + '|$)', 'i'));
  if (!m || m[1] === undefined) return [];
  return m[1].split('\n')
    .map(l => l.replace(/^[-•*]\s*/, '').trim())
    .filter(l => l.length > 10 && !/^\*\*/.test(l));  // skip spam lines starting with **
}

module.exports = function parse(job) {
  const result    = scaffold(job);
  const rawHtml   = job.raw_text || '';
  const html      = cleanHtml(rawHtml);
  const plain     = stripHtml(html);
  const tags      = job.tags || [];
  const scrapedAt = job.scraped_at;

  // Eligibility priority:
  //   1. Hard ineligibility signals in text (US work auth phrases etc.) — always wins
  //   2. Employer-written "Location:" line in the body
  //   3. Job board location tag ("Worldwide", "Remote, US", etc.)
  //   4. General text signals
  const textEligible = detectEligibility(plain);
  const bodyEligible = eligibilityFromBodyLocation(plain);
  const locEligible  = eligibilityFromLocation(job.location);
  const eligible     = textEligible === false
    ? false   // hard no — explicit US auth / sponsorship denial overrides job board tag
    : (bodyEligible ?? locEligible ?? textEligible);

  // For eligibility_flags reason: body location > job board location
  // If the job was made ineligible by a US work-auth phrase (not location), use "US-only"
  const bodyLocMatch = plain.match(/\bLocation\s*[:\-]\s*([^\n]{3,80})/i);
  const flagLocation = (textEligible === false && !bodyLocMatch)
    ? 'United States'   // ineligibility came from text, not a location string
    : (bodyLocMatch ? bodyLocMatch[1].trim() : job.location);

  const { remote, remote_type }                        = detectRemote(plain, job.location);
  const { is_va_role, va_specialization }              = detectVaRole(plain, job.title);
  const { time_tracker_required, time_tracker_tools }  = detectTimeTracker(plain);

  const requirements     = extractSectionWithFallback(html, plain, /requirements?|qualifications?|what you.?ll need|what makes you stand out/i);
  const responsibilities = extractSectionWithFallback(html, plain, /responsibilities?|what you.?ll do|how you.?ll make an impact|the role|your role/i);

  result.remote               = remote;
  result.remote_type          = remote_type;
  result.eligible             = eligible;
  result.is_va_role           = is_va_role;
  result.va_specialization    = va_specialization;
  result.time_tracker_required = time_tracker_required;
  result.time_tracker_tools   = time_tracker_tools;
  result.seniority            = detectSeniority(plain, job.title);
  result.employment_type      = detectEmploymentType(plain);
  result.salary               = extractSalary(html, plain);
  result.skills               = detectSkills(plain, tags);
  result.requirements         = requirements;
  result.responsibilities     = responsibilities;
  result.apply_url            = extractApplyUrl(html, job.url);
  result.apply_before         = extractApplyBefore(plain);
  result.start_date           = extractStartDate(plain);
  result.posted_at            = extractPostedAt(plain, scrapedAt);
  result.eligibility_flags    = buildEligibilityFlags(eligible, flagLocation, plain);

  return result;
};
