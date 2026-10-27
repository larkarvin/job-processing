'use strict';
const {
  stripHtml, extractSection, scaffold,
  detectEligibility, detectRemote, detectVaRole,
  detectTimeTracker, detectSkills, detectSeniority, detectEmploymentType,
  extractPostedAt, extractApplyBefore, extractApplyUrl,
  extractStartDate, extractSalary, buildEligibilityFlags, detectNonEnglish,
} = require('./base');

// geo_region values that mean "open to everyone"
const WORLDWIDE_REGIONS = new Set([
  'anywhere in the world', 'worldwide', 'global', 'anywhere',
]);

module.exports = function parse(job) {
  const result   = scaffold(job);
  const html     = job.raw_text || '';
  const plain    = stripHtml(html);
  const lower    = plain.toLowerCase();
  const tags     = job.tags || [];
  const scrapedAt = job.scraped_at;

  // Eligibility — geo_region is the most reliable signal for WWR
  const geoLower = (job.geo_region || '').toLowerCase();
  let eligibleOverride = null;
  if (WORLDWIDE_REGIONS.has(geoLower))                         eligibleOverride = true;
  else if (geoLower && !WORLDWIDE_REGIONS.has(geoLower))       eligibleOverride = false;

  const { remote, remote_type } = detectRemote(plain, job.location);
  const { is_va_role, va_specialization } = detectVaRole(plain, job.title);
  const { time_tracker_required, time_tracker_tools } = detectTimeTracker(plain);

  // WWR section headings:
  //   Summary:         "The Opportunity"
  //   Responsibilities: "Why this role is special", "You will"
  //   Requirements:    "You are", "What we are looking for", standard "Requirements"/"Qualifications"

  // Generic section extractor for plain text (not HTML list items)
  function extractPlainSection(text, headingRe) {
    const NEXT_HEADING = /\n(?:the opportunity|why this role|you will\b|you are\b|what we are looking for|why you should apply|responsibilities?|requirements?|qualifications?|your profile|your mission|the role|key responsibilities|must.?haves?|about us|benefits?|what we offer)/i;
    const m = text.match(new RegExp('(?:' + headingRe.source + ')[:\\s]*\\n([\\s\\S]*?)(?=' + NEXT_HEADING.source + '|$)', 'i'));
    if (!m || m[1] === undefined) return [];
    return m[1].split('\n').map(l => l.replace(/^[-•*]\s*/, '').trim()).filter(l => l.length > 5);
  }

  const requirements = [
    ...extractSection(html, /you\s+are\b|what we.?re looking for|requirements?|qualifications?|your\s+profile|what you.?ll need|what you bring|must.?haves?/i),
    ...extractPlainSection(plain, /you\s+are\b|what we.?re looking for|requirements?|qualifications?|your\s+profile|what you.?ll need|what you bring|must.?haves?/i),
  ].filter((v, i, a) => a.indexOf(v) === i);  // dedupe

  const responsibilities = [
    ...extractSection(html, /why this role is special|you\s+will\b|responsibilities?|what you.?ll do|your\s+mission|the\s+role|key\s+responsibilities|main\s+responsabilit/i),
    ...extractPlainSection(plain, /why this role is special|you\s+will\b|responsibilities?|what you.?ll do|your\s+mission|the\s+role|key\s+responsibilities|main\s+responsabilit/i),
  ].filter((v, i, a) => a.indexOf(v) === i);

  // Summary from "The Opportunity" section
  const oppRe = /the\s+opportunity\s*[\n:]([\s\S]*?)(?=\n(?:why this role|you will\b|you are\b|what we are looking for|why you should apply|responsibilities?|requirements?|about us)|$)/i;
  const oppMatch = plain.match(oppRe);
  const summary = oppMatch ? oppMatch[1].trim().replace(/\s+/g, ' ').slice(0, 500) : null;

  // Non-English posts are not actionable for our users — mark ineligible
  const nonEnglish = detectNonEnglish(plain);

  result.remote               = remote;
  result.remote_type          = remote_type;
  result.eligible             = nonEnglish ? false : detectEligibility(plain, eligibleOverride);
  result.is_va_role           = is_va_role;
  result.va_specialization    = va_specialization;
  result.time_tracker_required = time_tracker_required;
  result.time_tracker_tools   = time_tracker_tools;
  result.seniority            = detectSeniority(plain, job.title);
  result.employment_type      = detectEmploymentType(plain);
  result.skills               = detectSkills(plain, tags);
  result.requirements         = requirements;
  result.responsibilities     = responsibilities;
  result.summary              = summary;
  result.salary               = extractSalary(html, plain);
  result.apply_url            = extractApplyUrl(html, job.url);
  result.apply_before         = extractApplyBefore(plain);
  result.start_date           = extractStartDate(plain);
  result.posted_at            = extractPostedAt(plain, scrapedAt);
  result.eligibility_flags    = nonEnglish
    ? { geo_restricted: false, reason: 'Non-English listing', requires_visa_sponsorship: false, apac_allowed: false, sea_allowed: false }
    : buildEligibilityFlags(result.eligible, job.geo_region || job.location, plain);

  return result;
};
