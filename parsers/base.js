'use strict';

// ── HTML ──────────────────────────────────────────────────────────────────────

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi,         '\n')
    .replace(/<\/p>/gi,              '\n')
    .replace(/<\/li>/gi,             '\n')
    .replace(/<\/div>/gi,            '\n')
    .replace(/<h[1-6][^>]*>/gi,      '\n')
    .replace(/<\/h[1-6]>/gi,         '\n')
    .replace(/<[^>]+>/g,             '')
    .replace(/&lt;/g,        '<')
    .replace(/&gt;/g,        '>')
    .replace(/&amp;/g,       '&')
    .replace(/&quot;/g,      '"')
    .replace(/&apos;/g,      "'")
    .replace(/&nbsp;/g,      ' ')
    .replace(/&mdash;/gi,    '—')
    .replace(/&ndash;/gi,    '–')
    .replace(/&#8212;/g,     '—')
    .replace(/&#8211;/g,     '–')
    .replace(/&#\d+;/g,      '')
    .replace(/[ \t]+/g,      ' ')
    .replace(/\n{3,}/g,      '\n\n')
    .trim();
}

// Extract bullet list items under a named section heading.
// sectionRe: regex that matches the heading text (case-insensitive).
function extractSection(html, sectionRe) {
  // Find the heading
  const headingRe = new RegExp(
    '<(?:h[1-6]|strong|b)[^>]*>[^<]*' + sectionRe.source + '[^<]*</(?:h[1-6]|strong|b)>',
    'i'
  );
  const hIdx = html.search(headingRe);
  if (hIdx === -1) return [];

  // Grab the next <ul> or <ol> after the heading
  const after = html.slice(hIdx);
  const listMatch = after.match(/<[uo]l[^>]*>([\s\S]*?)<\/[uo]l>/i);
  if (!listMatch) return [];

  // Pull each <li> text
  const items = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(listMatch[1])) !== null) {
    const text = stripHtml(m[1]).trim();
    if (text) items.push(text);
  }
  return items;
}

// ── Keywords ──────────────────────────────────────────────────────────────────

const VA_KEYWORDS = [
  'virtual assistant', 'executive assistant', 'admin assistant',
  'administrative assistant', 'personal assistant', 'va role',
  'calendar management', 'inbox management', 'email management',
  'data entry', 'scheduling assistant', 'appointment setting',
];

const TIME_TRACKER_KEYWORDS = [
  'hubstaff', 'time doctor', 'timedoctor', 'toggl', 'clockify',
  'harvest', 'timely', 'deputy', 'tsheets', 't-sheets', 'jibble',
  'everhour', 'activitywatch', 'teramind', 'insightful', 'desktime',
  'time tracking', 'screenshot monitoring', 'activity monitoring',
  'track your time', 'time logging', 'hours logged',
];

const ELIGIBLE_SIGNALS = [
  'philippines', 'ph-based', 'filipino', 'southeast asia', 'sea-based',
  'apac', 'asia pacific', 'latin america', 'latam',
  'worldwide', 'anywhere in the world', 'work from anywhere',
  'open to all', 'international applicants', 'globally',
];

const INELIGIBLE_SIGNALS = [
  // Explicit location/residency restrictions
  'us only', 'u.s. only', 'united states only', 'us residents only',
  'us citizens only', 'contiguous us', 'stateside', 'domestic us', 'us-based only',
  'must be located in the us', 'must be in the united states', 'must reside in',
  // US tax / payroll signals
  'w-2 employee', 'w2 employee', 'i-9 verification', 'i9 verification',
  // Sponsorship denial — employer won't sponsor means international applicants can't apply
  'unable to sponsor', 'cannot sponsor', 'do not sponsor',
  'unable to support employment authorization',
  'does not require employer sponsorship',
  'sponsorship is not available',
  'no visa sponsorship',
];

// Regex for "authorized/right to work in [any specific country]".
// Matches US, AU, CA, UK, DE, NZ, EU, etc. — works for any country.
// Requires the country/region to start with a capital letter (proper noun),
// which rules out generic phrases like "in a role", "in our team", "in the future".
// Test against original plainText (not lowercased) to preserve capitalisation.
const WORK_AUTH_RE = /\b(?:(?:must\s+(?:have\s+)?)?(?:legally\s+)?(?:authorized|authorised|eligible)\s+to\s+work|(?:unrestricted\s+)?(?:authorization|authorisation|right)\s+to\s+work|work\s+(?:authorization|authorisation|permit|eligibility))\s+(?:in|for)\s+(?:the\s+)?[A-Z]/;

// Catches physical presence requirements: "Must be located in Jamaica",
// "candidates must be based in the US", "must reside in Canada", etc.
// Capital letter after "in" / "from" ensures we match proper nouns only.
const LOCATION_REQUIRED_RE = /\b(?:must\s+(?:be\s+)?(?:located|based|reside|live)\s+in|required\s+to\s+(?:be\s+)?(?:located|based|reside)\s+in|candidates?\s+must\s+(?:be\s+)?(?:from|in|based\s+in)|must\s+be\s+physically\s+(?:located|present|based)\s+in)\s+(?:the\s+)?[A-Z]/;

const SKILL_KEYWORDS = [
  'google workspace', 'google docs', 'google sheets', 'google drive',
  'microsoft office', 'microsoft 365', 'excel', 'microsoft word', 'powerpoint',
  'slack', 'notion', 'asana', 'trello', 'clickup', 'monday.com',
  'jira', 'basecamp', 'zapier', 'make.com', 'airtable', 'smartsheet',
  'canva', 'figma', 'adobe', 'shopify', 'woocommerce', 'wordpress',
  'salesforce', 'hubspot', 'zoho', 'pipedrive', 'mailchimp', 'activecampaign',
  'chatgpt', 'openai', 'midjourney', 'python', 'javascript', 'sql',
  'quickbooks', 'xero', 'freshbooks', 'zendesk', 'freshdesk', 'intercom',
];

// ── Detection helpers ─────────────────────────────────────────────────────────

function detectEligibility(plainText, override = null) {
  const lower = plainText.toLowerCase();
  // Hard ineligibility always wins — even if the job board says "Worldwide".
  // A geo_region tag is set by the employer globally; body text may restrict further.
  const hasIneligible = INELIGIBLE_SIGNALS.some(kw => lower.includes(kw))
                     || WORK_AUTH_RE.test(plainText)
                     || LOCATION_REQUIRED_RE.test(plainText);
  if (hasIneligible) return false;
  // Positive or negative override from caller (e.g. geo_region, location tag)
  if (override === true  || override === false) return override;
  const hasEligible = ELIGIBLE_SIGNALS.some(kw => lower.includes(kw));
  if (hasEligible) return true;
  return null;
}

function detectRemote(plainText, location = '') {
  const t = plainText.toLowerCase();
  const l = (location || '').toLowerCase();
  const remote = /\bremote\b/i.test(t) || /\bremote\b/i.test(l);
  let remote_type = null;
  if (/\bfully\s+remote\b|\b100\s*%\s*remote\b/i.test(t)) remote_type = 'fully_remote';
  else if (/\bhybrid\b/i.test(t))                          remote_type = 'hybrid';
  else if (remote)                                         remote_type = 'remote';
  return { remote, remote_type };
}

function detectVaRole(plainText, title = '') {
  const combined = ((title || '') + ' ' + plainText).toLowerCase();
  const is_va_role = VA_KEYWORDS.some(kw => combined.includes(kw));
  if (!is_va_role) return { is_va_role: false, va_specialization: null };

  let va_specialization = 'general_va';
  if (/social media|content creation|instagram|tiktok|facebook ads/.test(combined))
    va_specialization = 'social_media_va';
  else if (/bookkeeping|quickbooks|xero|accounting|accounts payable/.test(combined))
    va_specialization = 'bookkeeping_va';
  else if (/real estate|listings|mls|zillow|property management/.test(combined))
    va_specialization = 'real_estate_va';
  else if (/customer support|live chat|zendesk|freshdesk|ticket/.test(combined))
    va_specialization = 'customer_support_va';
  else if (/email|inbox|calendar|scheduling|executive support/.test(combined))
    va_specialization = 'admin_va';
  else if (/research|data entry|spreadsheet|web research/.test(combined))
    va_specialization = 'research_va';

  return { is_va_role, va_specialization };
}

function detectTimeTracker(plainText) {
  const lower = plainText.toLowerCase();
  const tools = TIME_TRACKER_KEYWORDS.filter(kw => lower.includes(kw));
  return {
    time_tracker_required: tools.length > 0,
    time_tracker_tools:    tools.map(t => t.charAt(0).toUpperCase() + t.slice(1)),
  };
}

// Pre-compile word-boundary regexes for skill matching to avoid false positives
// (e.g. "word" inside "Worldwide", "excel" inside "excellent", "make" as a verb)
const SKILL_REGEXES = SKILL_KEYWORDS.map(sk => ({
  sk,
  re: new RegExp('\\b' + sk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'),
}));

function detectSkills(plainText, tagsArr = []) {
  const fromText = SKILL_REGEXES.filter(({ re }) => re.test(plainText)).map(({ sk }) => sk);
  // Merge with tags already captured by the crawler (normalised to lowercase)
  const fromTags = Array.isArray(tagsArr)
    ? tagsArr.map(t => String(t).toLowerCase()).filter(Boolean)
    : [];
  return [...new Set([...fromText, ...fromTags])];
}

function detectSeniority(plainText, title = '') {
  const t = ((title || '') + ' ' + plainText).toLowerCase();
  if (/\b(c-level|chief|vp |vice president|president)\b/.test(t)) return 'executive';
  if (/\b(lead|principal|staff)\b/.test(t))                        return 'lead';
  if (/\b(senior|sr\.?\s)/i.test(t))                               return 'senior';
  if (/\b(mid.?level|mid.?senior|intermediate)\b/.test(t))         return 'mid';
  if (/\b(junior|jr\.?\s|entry.?level|associate|intern|graduate)\b/.test(t)) return 'entry';
  return null;
}

function detectEmploymentType(plainText) {
  const t = plainText.toLowerCase();
  if (/\bfull.?time\b/.test(t))  return 'full_time';
  if (/\bpart.?time\b/.test(t))  return 'part_time';
  if (/\bcontract\b/.test(t))    return 'contract';
  if (/\bfreelance\b/.test(t))   return 'freelance';
  return null;
}

// ── Posted date ───────────────────────────────────────────────────────────────

const MONTHS = {
  january:1,jan:1,february:2,feb:2,march:3,mar:3,april:4,apr:4,
  may:5,june:6,jun:6,july:7,jul:7,august:8,aug:8,
  september:9,sep:9,october:10,oct:10,november:11,nov:11,december:12,dec:12,
};

function extractPostedAt(plainText, scrapedAt) {
  const t = plainText || '';

  function toISO(y, m, d) {
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  function offsetDays(n) {
    const base = scrapedAt instanceof Date ? scrapedAt : new Date(scrapedAt || Date.now());
    const dt = new Date(base);
    dt.setDate(dt.getDate() - n);
    return toISO(dt.getFullYear(), dt.getMonth()+1, dt.getDate());
  }

  const isoRe  = /\b(20\d{2})[-\/](0?[1-9]|1[0-2])[-\/](0?[1-9]|[12]\d|3[01])\b/;
  const mdy    = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),?\s+(20\d{2})\b/i;
  const dmy    = /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(20\d{2})\b/i;
  const relRe  = /\b(?:posted\s+)?(\d+)\s+(day|week|month)s?\s+ago\b/i;
  const labelRe= /(?:posted(?:\s+on)?|date\s+posted|published(?:\s+on)?)\s*[:\-]?\s*([A-Za-z0-9,\s\/\-]+?)(?:\s*[\|<\n]|$)/i;

  const labelled = t.match(labelRe);
  if (labelled) {
    const frag = labelled[1].trim();
    const m = frag.match(isoRe) || frag.match(mdy) || frag.match(dmy);
    if (m) {
      if (m.length === 4 && !isNaN(+m[1])) return toISO(m[1], m[2], m[3]);
      if (MONTHS[(m[1]||'').toLowerCase()])  return toISO(m[3], MONTHS[m[1].toLowerCase()], m[2]);
      if (MONTHS[(m[2]||'').toLowerCase()])  return toISO(m[3], MONTHS[m[2].toLowerCase()], m[1]);
    }
  }

  const isoM = t.match(isoRe);
  if (isoM) return toISO(isoM[1], isoM[2], isoM[3]);
  const mdyM = t.match(mdy);
  if (mdyM) return toISO(mdyM[3], MONTHS[mdyM[1].toLowerCase()], mdyM[2]);
  const dmyM = t.match(dmy);
  if (dmyM) return toISO(dmyM[3], MONTHS[dmyM[2].toLowerCase()], dmyM[1]);
  if (/\btoday\b/i.test(t))     return offsetDays(0);
  if (/\byesterday\b/i.test(t)) return offsetDays(1);
  const relM = t.match(relRe);
  if (relM) {
    const n = parseInt(relM[1], 10);
    const u = relM[2].toLowerCase();
    return offsetDays(u==='day' ? n : u==='week' ? n*7 : n*30);
  }
  return null;
}

// ── Apply-before date ─────────────────────────────────────────────────────────

function extractApplyBefore(plainText) {
  const t = plainText || '';
  // "Apply before May 8th, 2026" / "Apply by May 8, 2026"
  // "Application deadline: May 8, 2026" / "Closing date: May 8"
  const re = /(?:apply\s+(?:before|by)|application\s+deadline|deadline|closing\s+date)\s*[:\-]?\s*([A-Za-z0-9,\s\/\-]+?)(?:\s*[\.\n\|]|$)/i;
  const m = t.match(re);
  if (!m) return null;
  const frag = m[1].trim();

  function toISO(y, m, d) {
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  const isoRe = /\b(20\d{2})[-\/](0?[1-9]|1[0-2])[-\/](0?[1-9]|[12]\d|3[01])\b/;
  const mdy   = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i;
  const dmy   = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(20\d{2})\b/i;

  const isoM = frag.match(isoRe);
  if (isoM) return toISO(isoM[1], isoM[2], isoM[3]);
  const mdyM = frag.match(mdy);
  if (mdyM) return toISO(mdyM[3], MONTHS[mdyM[1].toLowerCase()], mdyM[2]);
  const dmyM = frag.match(dmy);
  if (dmyM) return toISO(dmyM[3], MONTHS[dmyM[2].toLowerCase()], dmyM[1]);

  return null;
}

// ── Salary ────────────────────────────────────────────────────────────────────

// Parse a raw salary string into { min, max, currency }.
// Handles: "$66,300—$149,150 USD", "$60k-$90k", "$18 - $22 an hour", etc.
function parseSalaryString(raw) {
  if (!raw) return null;

  // Detect currency — check explicit suffix first, then symbol
  let currency = 'USD';
  if (/\bAUD\b/.test(raw))      currency = 'AUD';
  else if (/\bCAD\b/.test(raw)) currency = 'CAD';
  else if (/\bNZD\b/.test(raw)) currency = 'NZD';
  else if (/\bSGD\b/.test(raw)) currency = 'SGD';
  else if (/\bGBP\b|£/.test(raw)) currency = 'GBP';
  else if (/\bEUR\b|€/.test(raw)) currency = 'EUR';
  else if (/\bUSD\b|\$/.test(raw)) currency = 'USD';

  function toNumber(s) {
    s = s.replace(/,/g, '').trim();
    if (/k$/i.test(s)) return Math.round(parseFloat(s) * 1000);
    return Math.round(parseFloat(s));
  }

  // Range: $X — $Y  or  $X - $Y  or  X—Y (after $ stripped)
  const rangeM = raw.match(/\$?([\d,.k]+)\s*[-–—]\s*\$?([\d,.k]+)/i);
  if (rangeM) {
    const min = toNumber(rangeM[1]);
    const max = toNumber(rangeM[2]);
    if (!isNaN(min) && !isNaN(max)) return { min, max, currency };
  }

  // Single value
  const singleM = raw.match(/\$?([\d,.k]+)/i);
  if (singleM) {
    const val = toNumber(singleM[1]);
    if (!isNaN(val)) return { min: val, max: val, currency };
  }

  return null;
}

function extractSalary(html, plainText) {
  // Dash alternatives: literal chars + HTML entities not yet decoded
  const DASH = '(?:[-–—]|&mdash;|&ndash;|&#8212;|&#8211;)';
  const CCY  = '(?:\\s*(?:USD|EUR|GBP|AUD|CAD|NZD|SGD))?';
  const PER  = '(?:\\s*\\/(?:year|yr|hour|hr|mo|month)|\\s+(?:a\\s+year|per\\s+year|an?\\s+hour|per\\s+hour|a\\s+month))?';

  function clean(s) { return s.replace(/&mdash;|&ndash;|&#8212;|&#8211;/g, '—').replace(/\s+/g, ' ').trim(); }

  // Pattern 1: standalone <div> or <p> with a salary range (entities may still be raw)
  const divRe = new RegExp(
    `<(?:div|p)[^>]*>\\s*(\\$[\\d,.k]+\\s*${DASH}\\s*\\$?[\\d,.k]+${CCY}${PER})\\s*<\\/(?:div|p)>`, 'i'
  );
  const divM = html.match(divRe);
  if (divM) return parseSalaryString(clean(divM[1]));

  const t = plainText || '';

  // Pattern 2: labeled — "Salary:", "Compensation:", "Pay:", "Wage:", "Remuneration:"
  const labelRe = new RegExp(
    `(?:compensation|salary|pay(?:rate)?|wage|remuneration)\\s*[:\\-]\\s*(\\$[\\d,.k]+(?:\\s*[-–—]\\s*\\$?[\\d,.k]+)?${CCY}${PER})`, 'i'
  );
  const labelM = t.match(labelRe);
  if (labelM) return parseSalaryString(labelM[1].replace(/\s+/g, ' ').trim());

  // Pattern 3: "salary range ... \n $X—$Y"
  const sentenceM = t.match(
    /(?:salary\s+range|base\s+(?:pay|salary)|annual\s+(?:salary|compensation))[^\n]*\n\s*(\$[\d,.k]+\s*[-–—]\s*\$?[\d,.k]+[^\n]{0,30})/i
  );
  if (sentenceM) return parseSalaryString(sentenceM[1].replace(/\s+/g, ' ').trim());

  // Pattern 4: bare salary line
  const lineRe = new RegExp(
    `^\\s*(\\$[\\d,.k]+\\s*[-–—]\\s*\\$?[\\d,.k]+${CCY}${PER})\\s*$`, 'im'
  );
  const lineM = t.match(lineRe);
  if (lineM) return parseSalaryString(lineM[1].replace(/\s+/g, ' ').trim());

  return null;
}

// ── Start date ────────────────────────────────────────────────────────────────

function extractStartDate(plainText) {
  const t = plainText || '';
  const patterns = [
    /start(?:ing)?\s+date\s*[:\-]?\s*([^\n.]{2,60})/i,
    /preferred?\s+(?:start|joining|commencement)\s+date\s*[:\-]?\s*([^\n.]{2,60})/i,
    /preferable\s+joining\s+date\s*[:\-]?\s*([^\n.]{2,60})/i,
    /joining\s+date\s*[:\-]?\s*([^\n.]{2,60})/i,
    /available\s+(?:to\s+start|from)\s*[:\-]?\s*([^\n.]{2,60})/i,
    /expected\s+start\s*[:\-]?\s*([^\n.]{2,60})/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const frag = m[1].trim().replace(/[,.]$/, '');
    if (/asap|as\s+soon\s+as\s+possible/i.test(frag))  return 'ASAP';
    if (/immediate(?:ly)?/i.test(frag))                 return 'Immediate';
    if (/flexible|open|negotiable/i.test(frag))         return 'Flexible';
    const isoM = frag.match(/\b(20\d{2})[-\/](0?[1-9]|1[0-2])[-\/](0?[1-9]|[12]\d|3[01])\b/);
    if (isoM) return `${isoM[1]}-${String(isoM[2]).padStart(2,'0')}-${String(isoM[3]).padStart(2,'0')}`;
    const mdyM = frag.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
    if (mdyM) return `${mdyM[3]}-${String(MONTHS[mdyM[1].toLowerCase()]).padStart(2,'0')}-${String(mdyM[2]).padStart(2,'0')}`;
    // Only return raw fragment if it looks like a short date-ish phrase (no sentence words)
    if (frag.length <= 30 && !/\b(and|you|we|our|the|that|this|your)\b/i.test(frag)) return frag;
    return null;
  }
  return null;
}

// ── Eligibility flags — structured breakdown of why a job is eligible or not ─

function buildEligibilityFlags(eligible, location, plainText) {
  const l = (location || '').toLowerCase();
  const t = (plainText || '').toLowerCase();
  const combined = l + ' ' + t;

  const sea_kw      = /philippines|southeast\s+asia|\bsea\b(?:[\s\-]based)?|filipino|ph[\s\-]based/i.test(combined);
  const apac_kw     = /\bapac\b|asia[\s\-]pacific|southeast\s+asia|philippines/i.test(combined);
  const worldwide_kw= /worldwide|anywhere\s+in\s+the\s+world|work\s+from\s+anywhere|\bglobal\b|open\s+to\s+all|international\s+applicants/i.test(combined);
  const us_restricted = /\bus[\s\-]only\b|united\s+states\s+only|us\s+residents?\s+only|must\s+(?:be\s+)?(?:located|based)\s+in\s+the\s+us|authorized\s+to\s+work\s+in\s+the\s+us/i.test(combined);
  const visa_sponsored= /visa\s+sponsorship\s+(?:is\s+)?(?:available|provided|offered)|we\s+(?:do\s+)?sponsor\s+(?:work\s+)?visas?/i.test(combined);

  // Strip "Remote" prefix including variations like "Remote - ", "Remote-", "Remote "
  const rawLoc  = (location || '').replace(/^remote\s*[-–]\s*/i, '').replace(/^remote\s+/i, '').trim();
  const locClean = rawLoc.toLowerCase();

  // Preserve acronyms (all-caps) when title-casing
  function titleCase(s) {
    return s.split(/\s+/).map(w => w.toUpperCase() === w && w.length > 1 ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  let geo_restricted = null;
  let reason         = null;
  let sea_allowed    = null;
  let apac_allowed   = null;

  if (eligible === true) {
    geo_restricted = false;
    sea_allowed    = true;
    apac_allowed   = true;
    // Derive reason from location string first (authoritative), then fall back to text
    if      (/philippines/i.test(locClean))                         reason = 'Philippines';
    else if (/southeast[\s\-]?asia|\bsea\b/i.test(locClean))       reason = 'Southeast Asia';
    else if (/apac|asia[\s\-]pacific/i.test(locClean))              reason = 'APAC';
    else if (/worldwide|global|anywhere/i.test(locClean))           reason = 'Worldwide';
    else if (worldwide_kw)                                           reason = 'Worldwide';
    else if (/philippines/i.test(t))                                reason = 'Philippines';
    else if (/southeast\s+asia|\bsea\b/i.test(t))                   reason = 'Southeast Asia';
    else if (apac_kw)                                                reason = 'APAC';
  } else if (eligible === false) {
    geo_restricted = true;
    sea_allowed    = false;
    apac_allowed   = false;
    if      (us_restricted || /\bus\b|united\s+states|usa\b/.test(locClean)) reason = 'US-only';
    else if (/northeast\s+asia/i.test(locClean))                    reason = 'Northeast Asia';
    else if (/east\s+asia/i.test(locClean))                         reason = 'East Asia';
    else if (rawLoc)                                                 reason = rawLoc;  // keeps original casing
    else if (us_restricted)                                         reason = 'US-only';
  }

  return {
    geo_restricted,
    reason,
    requires_visa_sponsorship: visa_sponsored,
    apac_allowed,
    sea_allowed,
  };
}

// ── Apply URL — try to find explicit apply link in HTML, fall back to job.url ─

function extractApplyUrl(html, jobUrl) {
  // Look for an <a> whose text contains "apply" near the end of the document
  const applyLinkRe = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*(?:[^<]*\b(?:apply|application)\b[^<]*)\s*<\/a>/gi;
  let lastMatch = null;
  let m;
  while ((m = applyLinkRe.exec(html)) !== null) {
    const href = m[1];
    // Skip anchors, mailto, and relative fragments
    if (href.startsWith('#') || href.startsWith('mailto:')) continue;
    lastMatch = href.startsWith('http') ? href : null;
  }
  return lastMatch || jobUrl || null;
}

// ── Scaffold — builds a base result using fields already on the raw_jobs row ──

function scaffold(job) {
  return {
    id:                     job.id       || null,
    hash:                   job.hash     || null,
    title:                  job.title    || null,
    company:                job.company  || null,
    location:               job.location || null,
    geo_region:             job.geo_region || null,
    remote:                 null,
    remote_type:            null,
    eligible:               null,
    is_va_role:             false,
    va_specialization:      null,
    time_tracker_required:  false,
    time_tracker_tools:     [],
    seniority:              null,
    employment_type:        null,
    salary:                 null,
    requirements:           [],
    responsibilities:       [],
    skills:                 [],
    industries:             [],
    summary:                null,
    apply_url:              job.url || null,   // never null — fallback to listing URL
    apply_before:           null,
    start_date:             null,
    eligibility_flags:      null,
    source:                 job.source,
    posted_at:              null,
  };
}

// ── Internship detection — interns are never eligible regardless of location ───

function detectInternship(title, plainText) {
  const t = (title || '').toLowerCase();
  // Title is the strongest signal — match common patterns
  if (/\bintern(?:ship)?\b/.test(t))              return true;
  if (/\bapprenticeship\b/.test(t))               return true;
  if (/\bgraduate\s+(?:intern|trainee|program)\b/.test(t)) return true;
  if (/\btrainee\b/.test(t))                      return true;
  // Body text: only match if the phrase explicitly describes the role as an internship
  const b = (plainText || '').toLowerCase();
  if (/\bthis\s+is\s+an?\s+internship\b/.test(b)) return true;
  if (/\binternship\s+(?:position|role|program|opportunity)\b/.test(b)) return true;
  return false;
}

// Returns true if the plain text is predominantly non-English.
//
// Two independent signals — either alone is sufficient:
//
// 1. Non-ASCII Latin ratio > 2 %  (catches French, Spanish, Portuguese,
//    Romanian, etc. where accents are dense)
//
// 2. German stop word count ≥ 5  — words that are common German function
//    words but essentially never appear as standalone tokens in English prose:
//    und (and), oder (or), nicht (not), wenn (if/when), auch (also),
//    aber (but), bspw / bzw (German abbreviations).
//    Technical German often avoids umlauts, so the non-ASCII check alone
//    misses it.
//
// 3. Portuguese stop word count ≥ 3  (para, também, você, etc.)
function detectNonEnglish(plain) {
  const alpha = (plain || '').match(/[a-zA-Z\u00C0-\u024F]/g);
  if (!alpha || alpha.length < 80) return false; // too short to judge

  // Signal 1: non-ASCII character density
  const nonAscii = alpha.filter(c => c.charCodeAt(0) > 127).length;
  if (nonAscii / alpha.length > 0.02) return true;

  // Signal 2: German function words (word-boundary matched, case-insensitive)
  const germanHits = ((plain.match(/\b(und|oder|nicht|wenn|auch|aber|bspw|bzw)\b/gi)) || []).length;
  if (germanHits >= 5) return true;

  // Signal 3: Portuguese function words
  const ptHits = ((plain.match(/\b(para|também|você|vocês|isso|nosso|nossa|pelo|pela|então)\b/gi)) || []).length;
  if (ptHits >= 3) return true;

  return false;
}

module.exports = {
  stripHtml, extractSection, scaffold,
  detectEligibility, detectRemote, detectVaRole,
  detectTimeTracker, detectSkills, detectSeniority, detectEmploymentType,
  extractPostedAt, extractApplyBefore, extractApplyUrl,
  extractStartDate, extractSalary, parseSalaryString, buildEligibilityFlags,
  detectInternship, detectNonEnglish,
};
