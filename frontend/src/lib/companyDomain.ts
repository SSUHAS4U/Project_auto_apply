/**
 * The company's own website domain, read from a job's URL — or null when the URL doesn't
 * belong to the company.
 *
 * WHY: Logo.dev's lookup BY NAME guesses, and guesses wrong for common words — "Cognizant"
 * returned the WordPress logo, "Indeed" an unrelated consultancy. A lookup by DOMAIN is exact.
 * A posting on `careers.cognizant.com` tells us the company is `cognizant.com`, so when the
 * link is on the company's own site we look the logo up by that domain.
 *
 * A posting on a job board or an applicant-tracking host says nothing about the employer —
 * `linkedin.com/jobs/…` is LinkedIn's domain, not Adobe's — so those return null and the
 * caller falls back to the name.
 */

/** Hosts that carry OTHER companies' jobs. Their domain is never the employer's. */
const BOARDS = [
  'linkedin.com', 'indeed.com', 'naukri.com', 'glassdoor.com', 'glassdoor.co.in', 'monster.com',
  'foundit.in', 'shine.com', 'iimjobs.com', 'hirist.tech', 'hirist.com', 'instahyre.com', 'cutshort.io',
  'wellfound.com', 'angel.co', 'internshala.com', 'apna.co', 'timesjobs.com', 'freshersworld.com',
  'ziprecruiter.com', 'simplyhired.com', 'dice.com', 'remoteok.com', 'weworkremotely.com',
  'arbeitnow.com', 'remotive.com', 'jooble.org', 'adzuna.com', 'adzuna.in', 'careerjet.com',
  // applicant-tracking systems — the employer is in the PATH, not the host
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'workday.com', 'smartrecruiters.com',
  'workable.com', 'bamboohr.com', 'jobvite.com', 'icims.com', 'taleo.net', 'successfactors.com',
  'successfactors.eu', 'oraclecloud.com', 'freshteam.com', 'zohorecruit.com', 'zohorecruit.in',
  'recruitee.com', 'teamtailor.com', 'personio.de', 'personio.com', 'breezy.hr', 'jazzhr.com',
  'applytojob.com', 'darwinbox.in', 'keka.com', 'kekahire.com', 'springrecruit.com', 'rippling.com',
  'rippling-ats.com', 'dover.com', 'pinpointhq.com', 'eightfold.ai', 'phenompeople.com', 'avature.net',
  'forms.gle',
];

/**
 * Exact HOSTS that aren't an employer even though their domain can be — Google's job search
 * and Google Forms sit on google.com, but careers.google.com IS Google hiring.
 */
const NON_EMPLOYER_HOSTS = new Set(['google.com', 'www.google.com', 'docs.google.com', 'forms.google.com']);

/** Two-label public suffixes common in the jobs we see; the registrable domain is one label left. */
const SECOND_LEVEL = new Set(['co.in', 'co.uk', 'com.au', 'co.jp', 'com.sg', 'co.nz', 'com.br', 'co.za', 'org.in', 'net.in', 'ac.in', 'gov.in']);

function registrable(host: string): string | null {
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const last2 = parts.slice(-2).join('.');
  if (SECOND_LEVEL.has(last2)) return parts.length >= 3 ? parts.slice(-3).join('.') : null;
  return last2;
}

export function companyDomain(url?: string | null): string | null {
  if (!url) return null;
  let host: string;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  // An IP address or a single label (localhost) is never a company's public site.
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[') || !host.includes('.')) return null;
  const domain = registrable(host);
  if (!domain) return null;
  if (NON_EMPLOYER_HOSTS.has(host)) return null;
  if (BOARDS.some((b) => domain === b || host === b || host.endsWith('.' + b))) return null;
  return domain;
}
