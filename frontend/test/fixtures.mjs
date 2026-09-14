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
  '/api/applications': ['applied', 'interview', 'offer', 'rejected', 'saved'].map((st, i) => ({
    id: 'a' + i, jobId: 'j' + i, status: st, method: 'email',
    appliedAt: '2026-08-2' + i + 'T09:00:00Z', createdAt: '2026-08-20T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z', notes: 'y'.repeat(180),
    job: { id: 'j' + i, title: LONG_TITLE, company: i === 1 ? NOBREAK : LONG_CO, location: LONG_LOC, url: 'https://e.com/' + i },
  })),
  '/api/saved-jobs': JOBS.slice(0, 6).map((j, i) => ({
    id: 's' + i, title: j.title, company: j.company, location: j.location,
    url: j.url, sourceSite: 'linkedin', createdAt: '2026-08-30T09:00:00Z',
  })),
  '/api/notifications': {
    items: Array.from({ length: 6 }, (_, i) => ({
      id: 'n' + i, type: 'run_finished', title: LONG_TITLE, body: 'z'.repeat(200),
      read: i % 2 === 0, createdAt: '2026-09-0' + (i + 1) + 'T09:00:00Z',
    })),
    unreadCount: 3,
  },
  '/api/scout/jobs': JOBS.slice(0, 8).map((j, i) => ({ ...j, id: 'sc' + i, score: 90 - i })),
  '/api/daily/picks': { briefing: 'w'.repeat(500), generatedAt: '2026-09-14T06:00:00Z', jobs: JOBS.slice(0, 5) },
  '/api/resumes': Array.from({ length: 4 }, (_, i) => ({
    id: 'r' + i, name: 'Suhas_Backend_Java_SpringBoot_Resume_v' + (i + 1) + '_final_FINAL.pdf',
    type: 'resume', filename: 'resume' + i + '.pdf', contentType: 'application/pdf',
    sizeBytes: 248000, createdAt: '2026-08-01T09:00:00Z',
  })),
  '/api/agent/events': Array.from({ length: 12 }, (_, i) => ({
    id: 'e' + i, at: '2026-09-14T0' + (i % 9) + ':00:00Z', type: 'job_identified',
    portal: 'linkedin', title: LONG_TITLE, company: LONG_CO, detail: 'd'.repeat(120),
  })),
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
];
