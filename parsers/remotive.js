'use strict';
const {
  stripHtml, extractSection, scaffold,
  detectEligibility, detectRemote, detectVaRole,
  detectTimeTracker, detectSkills, detectSeniority, detectEmploymentType,
  extractPostedAt, extractApplyBefore, extractApplyUrl,
  extractStartDate, extractSalary, parseSalaryString, buildEligibilityFlags,
} = require('./base');

// remotive stores the candidate_required_location in the location field.
// Values like "Worldwide", "USA", "Europe", "Germany", etc.
function eligibilityFromLocation(location) {
  const l = (location || '').toLowerCase();
  if (/worldwide|anywhere|global|international/.test(l)) return true;
  if (/philippines|sea|apac|asia pacific|latin america/.test(l)) return true;
  if (/\bus\b|usa|united states/.test(l)) return false;
  if (/europe|germany|uk\b|france|spain|poland/.test(l)) return false;
  return null;
}

module.exports = function parse(job) {
  const result    = scaffold(job);
  const html      = job.raw_text || '';
  const plain     = stripHtml(html);
  const tags      = job.tags || [];
  const scrapedAt = job.scraped_at;

  // API-provided structured fields stored as prefixed tags by the crawler
  const salaryTag   = tags.find(t => String(t).startsWith('salary:'));
  const jobTypeTag  = tags.find(t => String(t).startsWith('job_type:'));
  const apiSalary   = salaryTag  ? parseSalaryString(salaryTag.replace(/^salary:/i, '').trim())   : null;
  const apiJobType  = jobTypeTag ? jobTypeTag.replace(/^job_type:/i, '').trim() : null;

  // Skill tags: filter out the prefixed meta-tags before passing to detectSkills
  const skillTags = tags.filter(t => !String(t).startsWith('salary:') && !String(t).startsWith('job_type:'));

  const locEligible = eligibilityFromLocation(job.location);
  const { remote, remote_type } = detectRemote(plain, job.location);
  const { is_va_role, va_specialization } = detectVaRole(plain, job.title);
  const { time_tracker_required, time_tracker_tools } = detectTimeTracker(plain);

  const requirements     = extractSection(html, /requirements?|qualifications?|what you.?ll need|what we.?re looking for/i);
  const responsibilities = extractSection(html, /responsibilities?|what you.?ll do|the role|your role/i);

  result.remote               = remote;
  result.remote_type          = remote_type;
  result.eligible             = locEligible ?? detectEligibility(plain);
  result.is_va_role           = is_va_role;
  result.va_specialization    = va_specialization;
  result.time_tracker_required = time_tracker_required;
  result.time_tracker_tools   = time_tracker_tools;
  result.seniority            = detectSeniority(plain, job.title);
  result.employment_type      = apiJobType || detectEmploymentType(plain);
  result.skills               = detectSkills(plain, skillTags);
  result.requirements         = requirements;
  result.responsibilities     = responsibilities;
  result.salary               = apiSalary || extractSalary(html, plain);
  result.apply_url            = extractApplyUrl(html, job.url);
  result.apply_before         = extractApplyBefore(plain);
  result.start_date           = extractStartDate(plain);
  result.posted_at            = extractPostedAt(plain, scrapedAt);
  result.eligibility_flags    = buildEligibilityFlags(result.eligible, job.location, plain);

  return result;
};
