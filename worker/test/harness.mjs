// A test harness that runs the REAL portal adapters against pages we control.
//
// Why this exists: the adapters could only ever be "tested" by running them at LinkedIn and
// Indeed and reading the log afterwards. That is not a test — it is a guess with a 20-minute
// feedback loop, and it is how a run came to print its plan and then nothing at all for weeks.
//
// Nothing here stubs the adapter. `runIndeed`/`runLinkedIn` are imported unmodified and driven
// through a real Chrome: real navigation, real selectors, real clicks, real frames. Only the
// two things we genuinely cannot have locally are replaced —
//   · the network  (Playwright request interception serves fixture HTML for the portal hosts)
//   · the backend  (a recording stub with the same method surface as src/api.js)
// — so a selector change, a silent `continue`, or a loop that never runs shows up here exactly
// as it would in production.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

// Collapse the human pacing for the whole suite. `humanDelay` reads this at call time, so it
// does not matter that module imports are hoisted above this line.
process.env.JOBPILOT_TEST_NO_PACING = '1';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) || null;
}

/**
 * A fake portal. `routes` is an ordered list of [RegExp, handler]; the first pattern that
 * matches the request URL wins and its handler returns the HTML to serve. Every request is
 * recorded, so a test can assert on what the adapter actually asked for — the search URLs it
 * built, whether it paged, which job pages it opened.
 */
export class FakeSite {
  constructor(routes = []) {
    this.routes = routes;
    this.requests = [];
  }

  add(pattern, handler) { this.routes.push([pattern, handler]); return this; }

  /** URLs the adapter navigated to, in order. */
  urls(filter) {
    return filter ? this.requests.filter((u) => filter.test(u)) : this.requests.slice();
  }

  async install(ctx) {
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      // Only document navigations are interesting; blocking sub-resources keeps runs fast and
      // stops a fixture from reaching the real internet through an <img> or a font.
      if (route.request().resourceType() !== 'document') return route.abort();
      this.requests.push(url);
      for (const [pattern, handler] of this.routes) {
        if (pattern.test(url)) {
          const body = await handler(url);
          if (body === null) return route.abort();
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
        }
      }
      return route.fulfill({ status: 404, contentType: 'text/html', body: '<html><body>404</body></html>' });
    });
  }
}

/**
 * A stand-in for src/api.js with the same surface. Every call is recorded on `.calls`, and the
 * verdict-returning methods are configurable so a test can drive the gate down each of its
 * branches (good fit, stack mismatch, AI unavailable) without a backend or an LLM.
 */
export class FakeApi {
  constructor(opts = {}) {
    this.calls = [];
    this.events = [];
    this.statuses = [];
    this.opts = opts;
    this.flow = null;
    this.eventFailures = 0;
  }

  #rec(name, arg) { this.calls.push({ name, arg }); }

  async profile() {
    this.#rec('profile');
    return this.opts.profile ?? {
      fullName: 'Test Candidate', email: 'test@example.com', phone: '9999999999',
      location: 'Bengaluru, India', country: 'India',
      skills: ['Java', 'Spring Boot', 'React', 'PostgreSQL'],
    };
  }

  async resume() {
    this.#rec('resume');
    return this.opts.resume ?? { hasResume: false };
  }

  async event(e) {
    this.#rec('event', e);
    this.events.push(e);
    return {};
  }

  async runStatus(runId, status, detail) {
    this.#rec('runStatus', { runId, status, detail });
    this.statuses.push({ status, detail });
    return {};
  }

  /** The job-fit verdict. Default: a strong match, so the happy path reaches the apply flow. */
  async evaluate(post) {
    this.#rec('evaluate', post);
    if (typeof this.opts.evaluate === 'function') return this.opts.evaluate(post);
    return { score: 88, techMatch: true, reason: 'Java/Spring match', missing: [], source: 'ai' };
  }

  async verifyPerson(p) {
    this.#rec('verifyPerson', p);
    if (typeof this.opts.verifyPerson === 'function') return this.opts.verifyPerson(p);
    return { contact: true, confidence: 90, reason: 'recruiter', topic: '' };
  }

  async answer(q, options) {
    this.#rec('answer', { q, options });
    if (typeof this.opts.answer === 'function') return this.opts.answer(q, options);
    return { answer: '3' };
  }

  /** fill.js records every question it meets so the owner can pre-answer it next time. */
  async recordQuestion(label, value) { this.#rec('recordQuestion', { label, value }); return {}; }

  async next() { this.#rec('next'); return this.opts.next ?? {}; }
  async claimOutreach(x) { this.#rec('claimOutreach', x); return this.opts.claimOutreach ?? { ok: true }; }
  async postIntent(x) { this.#rec('postIntent', x); return this.opts.postIntent ?? { hiring: true, confidence: 90 }; }
  async connectionNote(x) { this.#rec('connectionNote', x); return this.opts.connectionNote ?? { note: 'Hello' }; }
  async message(x) { this.#rec('message', x); return this.opts.message ?? { text: 'Hello' }; }

  /** Events of a given type — the dashboard-visible outcome of a run. */
  eventsOfType(type) { return this.events.filter((e) => e.type === type); }
}

/** Capture everything the adapter prints, so a test can assert the run is not silent. */
export function captureLog(verbose = !!process.env.VERBOSE) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(' '));
    if (verbose) original(...args);
  };
  return {
    lines,
    text: () => lines.join('\n'),
    restore: () => { console.log = original; },
  };
}

/**
 * Launch a real browser for the harness. Headless — this runs in CI as well as locally.
 *
 * `cookies` matters more than it looks: LinkedIn's signed-in check is the `li_at` cookie, so a
 * context without it exercises the authwall path and nothing else. Tests that mean to drive a
 * signed-in run must say so, and tests of the signed-out path get it for free by omitting it.
 */
export async function launch({ cookies = [] } = {}) {
  const executablePath = findChrome();
  if (!executablePath) throw new Error('No Chrome/Edge found for the harness');
  const browser = await chromium.launch({ executablePath, headless: true });
  const ctx = await browser.newContext();
  if (cookies.length) await ctx.addCookies(cookies);
  return { browser, ctx };
}

/** A signed-in LinkedIn session, as the adapter recognises one. */
export const LINKEDIN_SESSION = [{
  name: 'li_at', value: 'test-session-token', domain: '.linkedin.com', path: '/',
  httpOnly: true, secure: true, sameSite: 'None',
}];

/** The mutable run state the adapters read (`stopped`, `paused`, `action`, `runId`). */
export function makeState(over = {}) {
  return { runId: 'run-test-1', stopped: false, paused: false, action: '', ...over };
}
