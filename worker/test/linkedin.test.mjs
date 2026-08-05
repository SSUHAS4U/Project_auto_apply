// LinkedIn adapter — Phase 1 (Easy Apply) driven end to end against fixture pages.
//
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLinkedIn } from '../src/portals/linkedin.js';
import { FakeSite, FakeApi, launch, captureLog, makeState, LINKEDIN_SESSION } from './harness.mjs';
import * as fx from './linkedin-fixtures.mjs';

function site({ cards = 2, jobOpts = {}, searchOpts = {} } = {}) {
  return new FakeSite()
    // Job ids 9000+ are the reposted "Full-stack app developer @ Kefilo" role; every other id
    // is its own posting. Serving one page for every id would hide a de-duplication failure.
    .add(/\/jobs\/view\/(\d+)/, (url) => {
      const id = url.match(/view\/(\d+)/)[1];
      const repost = Number(id) >= 9000;
      return fx.linkedinJob({
        id,
        ...(repost ? { title: 'Full-stack app developer', company: 'Kefilo' } : {}),
        ...jobOpts,
      });
    })
    .add(/\/jobs\/search/, () => fx.linkedinSearch({ count: cards, ...searchOpts }));
}

const plan = {
  keywords: ['java developer'],
  locations: ['Bengaluru'],
  blockMinutes: 15,
  applyCap: 5,
  dailyTarget: 20,
  appliedToday: 0,
  pagesPerSearch: 1,
  fitMin: 75,
  phase1Minutes: 10,
  // Phase 1 only — the three outreach flows drive the post feed, which this fixture site does
  // not serve; they get their own coverage rather than being half-exercised here.
  flowConfig: {
    easyApply: { on: true },
    postScan: { on: false },
    emailOnly: { on: false },
    connections: { on: false },
  },
};

async function runOnce({ s, api = new FakeApi(), planOver = {}, stateOver = {}, signedIn = true }) {
  const { browser, ctx } = await launch({ cookies: signedIn ? LINKEDIN_SESSION : [] });
  const log = captureLog();
  try {
    await s.install(ctx);
    const page = await ctx.newPage();
    const state = makeState(stateOver);
    const result = await runLinkedIn(page, api, { ...plan, ...planOver }, state, ctx);
    return { result, api, log: log.text(), site: s, state };
  } finally {
    log.restore();
    await browser.close().catch(() => {});
  }
}

/** The description the adapter actually sent to the fit gate. */
function judgedDescription(api) {
  const ev = api.calls.find((c) => c.name === 'evaluate');
  return ev ? (ev.arg.description || '') : '';
}

test('the fit gate judges the JOB description, not the recruiter panel', async () => {
  const api = new FakeApi();
  await runOnce({ s: site(), api });
  const desc = judgedDescription(api);

  assert.ok(desc.length > 80, `nothing was sent to the gate to judge:\n${desc}`);
  assert.ok(/Spring Boot/.test(desc), `the real description was not picked up:\n${desc.slice(0, 300)}`);
  // "Meet the hiring team" sits in the same pane and is all recruitment/HR/onboarding language.
  // If it reaches the gate, a Java role gets scored against an HR job spec — which is exactly
  // what "stack mismatch (fit 0) — missing recruitment, HR, onboarding" looks like.
  assert.ok(!/Talent Acquisition Specialist/.test(desc),
    `the recruiter panel leaked into the judged description:\n${desc.slice(0, 300)}`);
  assert.ok(!/onboarding timelines/.test(desc),
    `hiring-team prose leaked into the judged description:\n${desc.slice(0, 300)}`);
});

test('a renamed description container still yields the job description, not a neighbour panel', async () => {
  // Simulates LinkedIn renaming #job-details, which forces the "largest text block" fallback.
  const api = new FakeApi();
  await runOnce({ s: site({ jobOpts: { descriptionSelector: 'class="jd-v2-renamed"' } }), api });
  const desc = judgedDescription(api);
  assert.ok(/Spring Boot/.test(desc),
    `the fallback picked the wrong block:\n${desc.slice(0, 300)}`);
  assert.ok(!/Talent Acquisition/.test(desc),
    `the fallback picked the recruiter panel:\n${desc.slice(0, 300)}`);
});

test('a renamed container must not hand the About-the-company panel to the gate', async () => {
  // THE "fit 0" REGRESSION, reproduced.
  //
  // The v103 fallback takes the LARGEST leaf text block in the details pane. On a staffing
  // firm's posting the About-the-company panel is longer than the job description and is
  // entirely recruitment/HR/onboarding prose. Feed that to the fit gate and the model
  // correctly reports the job as needing recruitment, HR and onboarding — which the worker
  // then prints as "stack mismatch (fit 0) — missing recruitment, HR, onboarding" against a
  // Java role. Nothing in that chain is wrong except which block was picked.
  const api = new FakeApi();
  await runOnce({
    s: site({ jobOpts: {
      descriptionSelector: 'class="jd-v2-renamed"',
      aboutPanel: fx.STAFFING_ABOUT,
    } }),
    api,
  });
  const desc = judgedDescription(api);
  assert.ok(!/recruitment lifecycle|recruitment delivery|onboarding specialists/i.test(desc),
    `the About-the-company panel was judged as the job:\n${desc.slice(0, 400)}`);
  assert.ok(/Spring Boot|Java/.test(desc),
    `the real job description was not what reached the gate:\n${desc.slice(0, 400)}`);
});

test('when no description can be read, the job becomes a manual lead — never a fit verdict', async () => {
  // If every candidate block is a neighbour panel, the honest answer is "I could not read it",
  // which gate.js turns into a manual lead. Inventing a score from whatever text was nearby is
  // what made an extraction failure look like 57 unsuitable jobs.
  const api = new FakeApi();
  const { log } = await runOnce({
    s: site({ jobOpts: {
      descriptionSelector: 'class="jd-v2-renamed"',
      description: 'Apply now.',                 // too thin to judge
      aboutPanel: fx.STAFFING_ABOUT,
    } }),
    api,
  });
  assert.equal(api.calls.filter((c) => c.name === 'evaluate').length, 0,
    'an unreadable description must not be sent for scoring at all');
  assert.ok(/no description to judge/.test(log), `the log must say what went wrong:\n${log}`);
  assert.ok(api.eventsOfType('manual_apply').length > 0, 'the job must survive as a manual lead');
});

test('a job title is never doubled by the screen-reader copy', async () => {
  const api = new FakeApi();
  await runOnce({ s: site(), api });
  const ids = api.eventsOfType('job_identified');
  assert.ok(ids.length > 0, 'no jobs were identified at all');
  for (const e of ids) {
    assert.ok(e.title && e.title.trim().length > 0, 'a job was reported with an empty title');
    assert.ok(!/(.{6,})\1/.test(e.title), `doubled title: "${e.title}"`);
    assert.ok(!/Backend DeveloperJava/.test(e.title), `doubled title: "${e.title}"`);
  }
});

test('a good match is applied for, all the way through the Easy Apply modal', async () => {
  const api = new FakeApi();
  const { result, log } = await runOnce({ s: site({ cards: 2 }), api });
  assert.ok(result.applied > 0, `nothing was applied to:\n${log}`);
  assert.equal(api.eventsOfType('easy_apply').length, result.applied,
    'every application must be recorded as an easy_apply event');
});

test('reposts of one role collapse to a single application', async () => {
  const api = new FakeApi();
  // 6 ids, all the same title+company, plus 1 genuine job.
  await runOnce({ s: site({ cards: 1, searchOpts: { repostsOf: 6 } }), api });
  const seen = api.eventsOfType('job_identified').map((e) => `${e.title}|${e.company}`);
  assert.equal(new Set(seen).size, seen.length,
    `the same role was processed more than once: ${JSON.stringify(seen)}`);
});

test('a stack mismatch is skipped and the reason is printed', async () => {
  const api = new FakeApi({
    evaluate: () => ({ score: 0, techMatch: false, reason: 'not a match',
      missing: ['recruitment', 'HR', 'onboarding'], source: 'ai' }),
  });
  const { result, log } = await runOnce({ s: site(), api });
  assert.equal(result.applied, 0);
  assert.ok(/stack mismatch \(fit 0\)/.test(log), `the skip must be explained:\n${log}`);
});

test('an empty profile is named as the cause, not disguised as 57 bad jobs', async () => {
  // What the backend returns when there is no candidate to compare against. Before this was
  // handled it arrived as source:"ai", score 0, techMatch false — indistinguishable from a
  // genuine stack mismatch, so an unfilled Profile read as "every job on LinkedIn is wrong".
  const api = new FakeApi({
    evaluate: () => ({ score: 0, techMatch: false, source: 'no_profile',
      reason: 'your JobPilot profile has no skills or experience saved', missing: [] }),
  });
  const { result, log } = await runOnce({ s: site(), api });
  assert.equal(result.applied, 0);
  assert.ok(/Profile/.test(log), `the log must point at the Profile, not the job:\n${log}`);
  assert.ok(!/stack mismatch/.test(log),
    `an empty profile must not be reported as a stack mismatch:\n${log}`);
  assert.ok(api.eventsOfType('manual_apply').length > 0,
    'the jobs are still real — they must survive as manual leads');
});

test('a job with no Easy Apply is recorded as a manual lead, never as applied', async () => {
  const api = new FakeApi();
  const { result } = await runOnce({ s: site({ jobOpts: { easyApply: false } }), api });
  assert.equal(result.applied, 0);
  assert.ok(api.eventsOfType('manual_apply').length > 0,
    'an employer-site job must become a manual lead');
});

test('the signed-out authwall is reported, not silently treated as "no jobs"', async () => {
  const s = new FakeSite().add(/linkedin\.com/, () => fx.authwall());
  const api = new FakeApi();
  const { result, log } = await runOnce({ s, api, signedIn: false });
  assert.equal(result.applied, 0);
  const said = log + JSON.stringify(api.events);
  assert.ok(/log in|sign|authwall|session/i.test(said),
    `a signed-out run must say so:\n${log}`);
});

test('the apply cap is respected', async () => {
  const api = new FakeApi();
  const { result } = await runOnce({ s: site({ cards: 6 }), api, planOver: { applyCap: 2 } });
  assert.equal(result.applied, 2);
});

test('a stopped run does not search', async () => {
  const s = site();
  const { result } = await runOnce({ s, stateOver: { stopped: true } });
  assert.equal(result.applied, 0);
  assert.equal(s.urls(/\/jobs\/search/).length, 0);
});

test('an unanswerable screening question stops the application rather than half-submitting it', async () => {
  // The backend cannot answer, so fillChoices/fillForm raise attention.
  const api = new FakeApi({ answer: () => ({ answer: '' }) });
  const { result, api: a } = await runOnce({ s: site(), api });
  assert.equal(result.applied, 0, 'must never submit a form it could not complete');
  assert.equal(a.eventsOfType('easy_apply').length, 0);
});
