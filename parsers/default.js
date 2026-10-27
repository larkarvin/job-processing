'use strict';
const {
  stripHtml, extractSection, scaffold,
  detectEligibility, detectRemote, detectVaRole,
  detectTimeTracker, detectSkills, detectSeniority, detectEmploymentType,
  extractPostedAt, extractApplyBefore, extractApplyUrl,
  extractStartDate, extractSalary, buildEligibilityFlags,
} = require('./base');

module.exports = function parse(job) {
  const result    = scaffold(job);
  const html      = job.raw_text || '';
  const plain     = stripHtml(html);
  const tags      = job.tags || [];
  const scrapedAt = job.scraped_at;

  const { remote, remote_type }          = detectRemote(plain, job.location);
  const { is_va_role, va_specialization } = detectVaRole(plain, job.title);
  const { time_tracker_required, time_tracker_tools } = detectTimeTracker(plain);

  const requirements     = extractSection(html, /requirements?|qualifications?/i);
  const responsibilities = extractSection(html, /responsibilities?|what you.?ll do/i);

  result.remote               = remote;
  result.remote_type          = remote_type;
  result.eligible             = detectEligibility(plain);
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
  result.start_date           = extractStartDate(plain);
  result.posted_at            = extractPostedAt(plain, scrapedAt);
  result.eligibility_flags    = buildEligibilityFlags(result.eligible, job.location, plain);

  return result;
};
