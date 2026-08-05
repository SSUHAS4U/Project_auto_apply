// Indeed adapter — driven end to end against fixture pages in a real browser.
//
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { runIndeed } from '../src/portals/indeed.js';
import { FakeSite, FakeApi, launch, captureLog, makeState } from './harness.mjs';
import * as fx from './fixtures.mjs';

/** A site that behaves like Indeed on a good day: search pages, job pages, an apply flow. */
function healthySite({ cards = 3, apply = 'indeed' } = {}) {
  return new FakeSite()
    .add(/\/viewjob\?jk=/, (url) => {
      const jk = url.match(/jk=([^&]+)/)[1];
      return fx.indeedJob({ jk, title: `Java Developer ${jk.slice(-1)}`, apply });
    })
    .add(/\/smartapply/, (url) => fx.indeedApplyStep({
      step: Number(url.match(/[?&]step=(\d+)/)?.[1] || 1),
      jk: url.match(/jk=([^&]+)/)?.[1] || 'jk000000',
    }))
    .add(/\/jobs\?/, (url) => {
      // Page 2+ returns the same keys, which is how the adapter learns to stop paging.
      const start = Number(url.match(/[?&]start=(\d+)/)?.[1] || 0);
      return fx.indeedSearch({ count: cards, startKey: start > 0 ? 0 : 0 });
    });
}

const plan = {
  keywords: ['java developer', 'backend engineer'],
  locations: ['Bengaluru'],
  blockMinutes: 15,
  applyCap: 5,
  dailyTarget: 20,
  appliedToday: 0,
  pagesPerSearch: 1,
  fitMin: 75,
};

async function runOnce({ site, api = new FakeApi(), planOver = {}, stateOver = {} }) {
  const { browser, ctx } = await launch();
  const log = captureLog();
  try {
    await site.install(ctx);
    const page = await ctx.newPage();
    const state = makeState(stateOver);
    const result = await runIndeed(page, api, { ...plan, ...planOver }, state, ctx);
    return { result, api, log: log.text(), lines: log.lines, site, state };
  } finally {
    log.restore();
    await browser.close().catch(() => {});
  }
}

test('a normal search page is not mistaken for a captcha wall', async () => {
  const site = healthySite();
  const { result, log, api } = await runOnce({ site });

  // THE REGRESSION. Cloudflare ships a telemetry blob containing the word "captcha" on
  // ordinary served pages. A substring test over raw HTML matched it, so three good searches
  // in a row "walled" the run, which then returned WITHOUT PRINTING ANYTHING — the exact
  // signature of the block that logged its plan and then died in silence.
  assert.ok(!/checkpoint|captcha/i.test(log),
    `a healthy page was reported as blocked:\n${log}`);
  assert.equal(api.statuses.filter((s) => s.status === 'needs_attention').length, 0,
    'a healthy run must not raise needs_attention');
  assert.ok(result.applied > 0, `expected applications, got ${result.applied}\n${log}`);
});

test('searches actually run, and each one is logged', async () => {
  const site = healthySite();
  const { log, site: s } = await runOnce({ site });

  const searches = s.urls(/\/jobs\?/);
  assert.equal(searches.length, 2, 'two keywords x one location = two searches');
  assert.ok(/in\.indeed\.com/.test(searches[0]), 'an Indian location must use in.indeed.com');
  assert.ok(/sort=date/.test(searches[0]), 'results must be sorted by date');
  // Every search prints a result line. Without this a run can do work invisibly.
  assert.equal((log.match(/🔎/g) || []).length, 2, `expected 2 search lines:\n${log}`);
});

test("an invisible reCAPTCHA v3 badge is not a captcha wall", async () => {
  // THE SECOND FALSE POSITIVE. Indeed runs reCAPTCHA v3 site-wide to score traffic silently;
  // it embeds a 0x0 iframe whose src contains "recaptcha" on ORDINARY pages. Matching the
  // selector alone made every healthy search read as a wall, so a run printed
  //   "Backend Developer · Bengaluru -> Indeed is showing a checkpoint (1/3)"
  // against a page that was serving results perfectly well. A challenge only counts if it is
  // actually rendered in front of you.
  const site = healthySite();
  const { result, log, api } = await runOnce({ site });
  assert.ok(!/checkpoint/i.test(log), `an invisible v3 badge was read as a wall:\n${log}`);
  assert.equal(api.statuses.filter((s) => s.status === 'needs_attention').length, 0);
  assert.ok(result.applied > 0, `the run should have proceeded normally:\n${log}`);
});

test('a page serving job results is never called a wall', async () => {
  // Corroboration: whatever else a page contains, results mean it is not blocking us.
  const site = new FakeSite()
    .add(/\/viewjob\?jk=/, (url) => fx.indeedJob({ jk: url.match(/jk=([^&]+)/)[1] }))
    .add(/\/smartapply/, (url) => fx.indeedApplyStep({
      step: Number(url.match(/[?&]step=(\d+)/)?.[1] || 1),
      jk: url.match(/jk=([^&]+)/)?.[1] || 'jk000000',
    }))
    // Results AND a full-size recaptcha box on the same page.
    .add(/\/jobs\?/, () => fx.indeedSearch({ count: 3 }).replace(
      '</body>', '<div class="g-recaptcha" style="width:300px;height:400px"></div></body>'));
  const { log } = await runOnce({ site });
  assert.ok(!/checkpoint/i.test(log), `a page with results must not be a wall:\n${log}`);
  assert.ok(/🔎/.test(log), `the search should have been read:\n${log}`);
});

test('a real captcha wall is detected, reported out loud, and ends the block', async () => {
  const site = new FakeSite().add(/\/jobs\?|\/viewjob/, () => fx.cloudflareChallenge());
  const { result, log, api } = await runOnce({ site });

  assert.equal(result.applied, 0);
  assert.ok(/checkpoint|captcha/i.test(log),
    `a blocked run must SAY it is blocked, not return in silence:\n${log}`);
  assert.ok(api.statuses.some((s) => s.status === 'needs_attention'),
    'a blocked run must raise needs_attention');
});

test("Indeed's own blocked page is detected too", async () => {
  const site = new FakeSite().add(/\/jobs\?|\/viewjob/, () => fx.indeedBlocked());
  const { log, api } = await runOnce({ site });
  assert.ok(/checkpoint|captcha/i.test(log), `must detect indeed.com's blocked page:\n${log}`);
  assert.ok(api.statuses.some((s) => s.status === 'needs_attention'));
});

test('an empty plan says which side is empty instead of doing nothing', async () => {
  const site = healthySite();
  const { result, log } = await runOnce({ site, planOver: { keywords: [] } });
  assert.equal(result.applied, 0);
  assert.ok(/Nothing to search/i.test(log), `expected an explanation:\n${log}`);
  assert.ok(/0 search term\(s\)/.test(log));
});

test('a search that returns no cards prints diagnostics rather than a silent zero', async () => {
  const site = new FakeSite().add(/\/jobs\?/, () => fx.indeedSearch({ count: 0 }));
  const { log } = await runOnce({ site });
  assert.ok(/\[diag\]/.test(log), `an empty search must dump what the page was:\n${log}`);
  assert.ok(/Indeed returned no jobs/i.test(log));
});

test('employer-site jobs are left for manual apply, never auto-submitted', async () => {
  const site = healthySite({ apply: 'external' });
  const { result, api } = await runOnce({ site });
  assert.equal(result.applied, 0, 'must not claim to have applied on an employer site');
  assert.ok(api.eventsOfType('manual_apply').length > 0, 'must be recorded as a manual lead');
});

test('every job being external is called out as a probable selector fault', async () => {
  const site = healthySite({ cards: 6, apply: 'external' });
  const { log } = await runOnce({ site, planOver: { applyCap: 20 } });
  assert.ok(/EVERY job reported no Indeed Apply button/.test(log),
    `6 external jobs and 0 applies must be flagged as suspicious:\n${log}`);
});

test('the gate blocks a stack mismatch and says why', async () => {
  const site = healthySite();
  const api = new FakeApi({
    evaluate: () => ({ score: 40, techMatch: false, reason: 'Python role', missing: ['Django'], source: 'ai' }),
  });
  const { result, log } = await runOnce({ site, api });
  assert.equal(result.applied, 0);
  assert.ok(/stack mismatch \(fit 40\)/.test(log), `the skip must state the reason:\n${log}`);
  assert.ok(/missing Django/.test(log));
});

test('an unavailable AI evaluator never auto-applies — it fails closed to manual', async () => {
  const site = healthySite();
  const api = new FakeApi({ evaluate: () => ({ score: 38, source: 'keyword' }) });
  const { result, api: a } = await runOnce({ site, api });
  assert.equal(result.applied, 0, 'keyword overlap must never be enough to submit');
  assert.ok(a.eventsOfType('manual_apply').length > 0);
});

test('a senior role is skipped before the gate is ever consulted', async () => {
  const site = new FakeSite()
    .add(/\/viewjob\?jk=/, () => fx.indeedJob({ title: 'Senior Staff Engineer' }))
    .add(/\/jobs\?/, () => fx.indeedSearch({ count: 2 }));
  const api = new FakeApi();
  const { result } = await runOnce({ site, api });
  assert.equal(result.applied, 0);
  assert.equal(api.calls.filter((c) => c.name === 'evaluate').length, 0,
    'a senior role should not cost an AI call');
});

test('the apply cap is respected exactly', async () => {
  const site = healthySite({ cards: 10 });
  const { result } = await runOnce({ site, planOver: { applyCap: 2 } });
  assert.equal(result.applied, 2, 'must stop at the cap, not overshoot it');
});

test('a met quota returns immediately without opening a browser page', async () => {
  const site = healthySite();
  const { result, log, site: s } = await runOnce({ site, planOver: { applyCap: 0 } });
  assert.equal(result.applied, 0);
  assert.ok(/quota is already met/i.test(log));
  assert.equal(s.urls(/indeed/).length, 0, 'no navigation should happen at all');
});

test('stopping the run halts it before the first search', async () => {
  const site = healthySite();
  const { result, site: s } = await runOnce({ site, stateOver: { stopped: true } });
  assert.equal(result.applied, 0);
  assert.equal(s.urls(/\/jobs\?/).length, 0, 'a stopped run must not search');
});

test('the same job is never processed twice across searches', async () => {
  // Both searches return the identical job keys — which is what Indeed actually does per city.
  const site = healthySite({ cards: 3 });
  const { site: s } = await runOnce({ site, planOver: { locations: ['Bengaluru', 'Hyderabad'] } });
  const opened = s.urls(/\/viewjob\?jk=/);
  assert.equal(new Set(opened).size, opened.length, 'no job page should be opened twice');
});
