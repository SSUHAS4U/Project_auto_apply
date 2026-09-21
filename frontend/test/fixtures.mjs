// API fixtures for the responsive test, shaped from src/types/index.ts and api/client.ts.
//
// Wrong shapes are worse than no shapes: an array where a page expects an object throws during
// render, the page comes out blank, and a blank page has no layout to measure — which is how an
// earlier version of this harness cheerfully reported "no problems" on 160 blank screenshots.

const NOBREAK = 'Reallylongunbreakablecompanynamewithnospaces';
const LONG_TITLE = 'Senior Staff Software Engineer, Platform Infrastructure & Developer Experience (Remote, India)';
const LONG_CO = 'Thoughtworks Technologies India Private Limited';
const LONG_LOC = 'Hinjawadi Phase 2, Pimpri-Chinchwad, Pune, Maharashtra, India';

const page0 = { items: [], page: 0, size: 20, total: 0, totalPages: 0 };

/** The empty state — one of the states every screen must render correctly. */
export const EMPTY = {
  '/api/auth/me': { id: 'u1', email: 'dev@example.com', fullName: 'S Suhas', role: 'ADMIN', isAdmin: true },
  // Google configured and sign-up open, so the register route renders its FULL form (the
  // widest state) and the Google button's host is laid out.
  '/api/auth/config': { googleClientId: 'test-client.apps.googleusercontent.com', registrationOpen: true },
  '/api/profile': {
    fullName: 'S Suhas', email: 'dev@example.com', phone: '', headline: '', location: '',
    skills: [], links: {}, experience: [], education: [], projects: [], achievements: [], certifications: [],
  },
  '/api/ai/status': {
    provider: 'auto', enabled: true, remainingToday: -1, order: ['groq', 'gemini'], cooling: {},
    providers: [
      { provider: 'groq', configured: true, model: 'openai/gpt-oss-120b', inRotation: true, restingSeconds: 0 },
      { provider: 'gemini', configured: true, model: 'gemini-3.5-flash', inRotation: true, restingSeconds: 0 },
    ],
  },
  '/api/agent/status': {
    paused: false, workerConfigured: true, workerOnline: false, activeRun: null,
    pendingApprovals: 0, liveAction: null, liveUpdatedAt: null,
    metricsToday: { applied: 0, contacted: 0, scanned: 0, skipped: 0, failed: 0 },
  },
  // Timestamps are relative to NOW: the dashboard scopes every tile to a time window, so a
  // hard-coded date silently falls outside it and every metric reads 0 — which is how these
  // tiles came to be laid out only ever containing a single digit.
  '/api/agent/events': [],
  '/api/agent/flows': {},
  '/api/agent/connections': [],
  '/api/agent/message-template': { template: '' },
  '/api/engine/status': {
    aiEnabled: true, setupReady: true, checklist: {}, scrapeRunning: false, scrapeProgress: '',
    rankRunning: false, rankProgress: '', jobStatusCounts: {}, appStageCounts: {},
    autopilot: { enabled: false, running: false, dailyCap: 0, appliedToday: 0 },
  },
  '/api/engine/profile': { titles: [], locations: [], skills: [], minScore: 60 },
  '/api/engine/prefill': { titles: [], locations: [], skills: [] },
  '/api/notifications': { items: [], unreadCount: 0 },
  '/api/daily/picks': { briefing: '', generatedAt: null, jobs: [] },
  '/api/scout/jobs': [],
  '/api/saved-jobs': [],
  '/api/resumes': [],
  '/api/documents': [],
  '/api/jobs': page0,
  '/api/applications': [],
  '/api/metrics/ingest': { running: false, totalJobs: 0, lastRun: null, nextRun: null },
  '/api/admin/users': [],
  '/api/admin/secrets': [],
};

const job = (i, over) => ({
  id: 'j' + i, source: 'adzuna', title: LONG_TITLE, company: LONG_CO, location: LONG_LOC,
  remote: true, url: 'https://example.com/jobs/' + i, applyType: 'email',
  applyEmail: 'careers.recruitment.team@' + NOBREAK.toLowerCase() + '.com',
  salaryText: '₹18,00,000 - ₹32,00,000 a year', postedAt: '2026-09-01T10:00:00Z',
  fetchedAt: '2026-09-01T10:00:00Z', matchScore: 87, description: 'x'.repeat(400), ...over,
});

const JOBS = [
  job(1),
  job(2, { title: NOBREAK + NOBREAK, company: NOBREAK, matchScore: 100 }),
  job(3, { title: 'QA', company: 'IBM', location: 'Pune', matchScore: 0, salaryText: '' }),
  ...Array.from({ length: 9 }, (_, k) => job(10 + k)),
];

/**
 * The populated state, deliberately at the extremes: the longest title, a company name with no
 * space to wrap on, a salary range, a briefing with no whitespace in it.
 *
 * This is where the defects were. With EMPTY data every page was clean at all five widths; with
 * this data, Daily picks overflowed the viewport by 5119px, Notifications by 1123px and Saved
 * jobs by 412px — and Notifications was still overflowing at 1920. A responsive check that only
 * loads empty screens proves almost nothing.
 */
export const POPULATED = {
  ...EMPTY,
  '/api/jobs': { items: JOBS, page: 0, size: 20, total: 1284, totalPages: 65 },
  // The tracker renders the SAME card as the board, so its fixture has to carry what that
  // card reads — description, source, salaryText, postedAt — plus the states that break it:
  // a zero score, an ABSENT score, and a manual entry with no linked job at all.
  '/api/applications': [
    ...['applied', 'interviewing', 'offer', 'rejected', 'withdrawn'].map((st, i) => ({
      id: 'a' + i, jobId: 'j' + i, status: st, method: 'email',
      appliedAt: '2026-08-2' + i + 'T09:00:00Z', createdAt: '2026-08-20T09:00:00Z',
      updatedAt: '2026-09-01T09:00:00Z', notes: 'y'.repeat(180),
      job: {
        id: 'j' + i, title: LONG_TITLE, company: i === 1 ? NOBREAK : LONG_CO, location: LONG_LOC,
        url: 'https://e.com/' + i, applyType: 'ats', remote: i % 2 === 0,
        // i === 2 has a ZERO score (must render the panel, not hide it as falsy);
        // i === 3 has NO score at all (must hide the panel).
        matchScore: i === 3 ? undefined : (i === 2 ? 0 : 90 - i * 7),
        description: 'x'.repeat(400) + ' Java Spring Boot Kubernetes',
        source: 'greenhouse', salaryText: '₹18,00,000 - ₹32,00,000 a year',
        postedAt: '2026-09-01T10:00:00Z',
      },
    })),
    // Manual entry: no linked job whatsoever. The card must degrade, not throw.
    { id: 'a-manual', status: 'interested', method: 'manual',
      createdAt: '2026-08-20T09:00:00Z', updatedAt: '2026-09-02T09:00:00Z', job: null },
  ],
  // Saved jobs deliberately mix the two shapes that now coexist in a real database.
  '/api/saved-jobs': [
    // Post-2026-09-19: the extension captured a description, so the card is FULL.
    ...JOBS.slice(0, 3).map((j, i) => ({
      id: 's' + i, title: j.title, company: j.company, location: j.location,
      url: j.url, sourceSite: 'linkedin', createdAt: '2026-08-30T09:00:00Z',
      description: 'x'.repeat(400) + ' Java Spring Boot React', matchScore: 88 - i * 9,
      promotedJobId: i === 0 ? 'j0' : undefined,
    })),
    // Pre-migration rows: no description, no score. These must render SPARSE — the whole
    // reason the card has that mode. Includes the real-world junk titles the weak extractor
    // produced ("IBM" as both title and company, "Single Position").
    { id: 's-old-1', title: 'IBM', company: 'IBM', url: 'https://careers.ibm.com/job/1',
      sourceSite: 'careers.ibm.com', createdAt: '2026-07-14T09:00:00Z', promotedJobId: undefined },
    { id: 's-old-2', title: 'Single Position', company: 'apply', url: 'https://apply.careers.microsoft.com/x',
      sourceSite: 'apply.careers.microsoft.com', createdAt: '2026-06-24T09:00:00Z', promotedJobId: 'j9' },
    { id: 's-old-3', title: NOBREAK + NOBREAK, company: NOBREAK, location: LONG_LOC,
      url: 'https://e.com/verylong', sourceSite: NOBREAK.toLowerCase() + '.com',
      createdAt: '2026-06-23T09:00:00Z' },
  ],
  '/api/notifications': {
    items: Array.from({ length: 6 }, (_, i) => ({
      id: 'n' + i, type: 'run_finished', title: LONG_TITLE, body: 'z'.repeat(200),
      read: i % 2 === 0, createdAt: '2026-09-0' + (i + 1) + 'T09:00:00Z',
    })),
    unreadCount: 3,
  },
  // sourceSite drives the source filter, which is now built from what is PRESENT rather than
  // a hardcoded list — so the fixture carries a realistic spread including a Jooble origin.
  '/api/scout/jobs': JOBS.slice(0, 8).map((j, i) => ({
    ...j, id: 'sc' + i, score: 90 - i, matchScore: 90 - i, snippet: 'x'.repeat(220),
    sourceSite: ['linkedin', 'jooble', 'decentrajobs.com', 'careerjet'][i % 4],
    fetchedAt: '2026-09-14T06:00:00Z',
  })),
  '/api/daily/picks': { briefing: 'w'.repeat(500), generatedAt: '2026-09-14T06:00:00Z', curated: true, jobs: JOBS.slice(0, 5) },
  '/api/resumes': Array.from({ length: 4 }, (_, i) => ({
    id: 'r' + i, name: 'Suhas_Backend_Java_SpringBoot_Resume_v' + (i + 1) + '_final_FINAL.pdf',
    type: 'resume', filename: 'resume' + i + '.pdf', contentType: 'application/pdf',
    sizeBytes: 248000, createdAt: '2026-08-01T09:00:00Z',
  })),
  // Volume, not a token sample. The dashboard tiles COUNT these, so a handful of identical
  // events produced single-digit metrics and the tiles were never laid out with a real number
  // in them — which is exactly the case that overflows. 'post_analysed' is summed from the
  // "scanned N" in its detail, so that one carries a deliberately large N.
  '/api/agent/events': [
    ...Array.from({ length: 40 }, (_, i) => ({
      id: 'pa' + i, createdAt: new Date(Date.now() - i * 36e5 * 11).toISOString(), type: 'post_analysed',
      portal: 'linkedin', title: LONG_TITLE, company: LONG_CO,
      detail: `scanned ${9000 + i} hiring post(s) for "java backend developer hyderabad"`,
    })),
    ...['job_identified', 'relevant', 'applied', 'connection_sent', 'message_sent',
      'email_sent', 'reply_received'].flatMap((type, t) =>
      Array.from({ length: 220 }, (_, i) => ({
        id: `${type}-${i}`, createdAt: new Date(Date.now() - i * 36e5 * 11).toISOString(), type,
        jobId: `job-${t}-${i}`, portal: i % 2 ? 'linkedin' : 'indeed',
        title: LONG_TITLE, company: i % 3 === 0 ? NOBREAK : LONG_CO, detail: 'd'.repeat(120),
      }))),
  ],
  '/api/admin/users': Array.from({ length: 5 }, (_, i) => ({
    id: 'u' + i, email: 'averylongemailaddress.forthisuser' + i + '@' + NOBREAK.toLowerCase() + '.com',
    fullName: 'Candidate Number ' + i, role: i === 0 ? 'ADMIN' : 'USER', createdAt: '2026-01-0' + (i + 1),
  })),
  '/api/metrics/ingest': {
    running: false, totalJobs: 128456,
    lastRun: { at: '2026-09-14T05:00:00Z', updated: '1,284', inserted: 312, status: 'ok' },
    nextRun: '2026-09-15T05:00:00Z',
  },
  // Real certificate filenames, which is what the page actually has to lay out. These were
  // empty in the first version of this fixture, so every Profile test passed while the live
  // page pushed its document cards past the right edge.
  '/api/documents': [
    { id: 'd1', name: 'AWS Certified Solutions Architect - Associate certificate - SuhasS.pdf',
      type: 'certificate', filename: 'aws-saa.pdf', contentType: 'application/pdf', sizeBytes: 117760, createdAt: '2026-06-24T09:00:00Z' },
    { id: 'd2', name: 'AWS Certified Developer - Associate certificate - SuhasS-2026.pdf',
      type: 'certificate', filename: 'aws-dva.pdf', contentType: 'application/pdf', sizeBytes: 33790, createdAt: '2026-06-24T09:00:00Z' },
    { id: 'd3', name: 'AWS Certified Cloud Practitioner certificate.pdf',
      type: 'certificate', filename: 'aws-ccp.pdf', contentType: 'application/pdf', sizeBytes: 30720, createdAt: '2026-06-24T09:00:00Z' },
    { id: 'd4', name: NOBREAK + '-transcript-final.pdf',
      type: 'transcript', filename: 't.pdf', contentType: 'application/pdf', sizeBytes: 812000, createdAt: '2026-05-01T09:00:00Z' },
  ],
  '/api/profile': {
    fullName: 'S Suhas', email: 'dev@example.com', phone: '+91 90000 00000',
    headline: 'Senior Java Backend Engineer — Spring Boot, Kafka, GCP, Kubernetes, Microservices',
    location: LONG_LOC, summary: 'q'.repeat(600),
    skills: ['Java', 'Spring Boot', 'Kafka', 'PostgreSQL', 'Kubernetes', 'GCP', 'Terraform', 'React', 'TypeScript', 'Docker'],
    links: { linkedin: 'https://linkedin.com/in/suhas', github: 'https://github.com/suhas', portfolio: 'https://' + NOBREAK.toLowerCase() + '.dev' },
    experience: [{ company: LONG_CO, title: LONG_TITLE, from: '2023-01', to: 'Present', description: 'e'.repeat(300) }],
    education: [{ school: 'Jawaharlal Nehru Technological University Hyderabad', degree: 'B.Tech Computer Science', from: '2019', to: '2023' }],
    projects: [{ name: NOBREAK, description: 'p'.repeat(250), url: 'https://e.com' }],
    achievements: [{ title: 'Runner-up, Smart India Hackathon 2022 (Nationals)', description: 'a'.repeat(160) }],
    certifications: [
      { name: 'AWS Certified Solutions Architect - Associate', issuer: 'Amazon Web Services', year: '2026', url: 'https://example.com/verify/aws-saa-0001' },
      { name: 'AWS Certified Developer - Associate', issuer: 'Amazon Web Services', year: '2026', url: 'https://example.com/verify/aws-dva-0002' },
      { name: 'Oracle Certified Professional, Java SE 17 Developer', issuer: 'Oracle', year: '2025', url: 'https://example.com/verify/ocp' },
    ],
  },
};

export const ROUTES = [
  ['/', 'Dashboard'], ['/jobs', 'Jobs'], ['/auto-apply', 'Engine'],
  ['/connections', 'Connections'], ['/daily', 'DailyPicks'], ['/scout', 'Scout'],
  ['/resumes', 'Resumes'], ['/assistant', 'Assistant'], ['/compose', 'Compose'],
  ['/applications', 'Applications'], ['/saved', 'SavedJobs'],
  ['/notifications', 'Notifications'], ['/profile', 'Profile'],
  ['/settings', 'Settings'], ['/admin', 'Admin'], ['/login', 'Auth'],
  ['/register', 'Register'], ['/welcome', 'Home'],
];
