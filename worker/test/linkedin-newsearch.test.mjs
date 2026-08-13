// LinkedIn's rewritten results page — the one that produced 110 searches × 0 jobs.
//
// LinkedIn moved /jobs/search/ to /jobs/search-results/ and hashed the card classes. Every
// selector the adapter used matched nothing, so pages full of jobs reported "0 Easy-Apply
// jobs" while returning HTTP 200 on a live session. That looked exactly like being blocked,
// and it cost three wrong diagnoses before the redirect showed up in the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSite, FakeApi, launch, captureLog, makeState, LINKEDIN_SESSION } from './harness.mjs';
import { runLinkedIn } from '../src/portals/linkedin.js';
import * as fx from './linkedin-fixtures.mjs';

/** The new results page: no data-job-id, no known class — only job links. */
function hashedResults(count = 3) {
  const card = (i) => `
    <div class="_a4f2c9 _7bd1e0 x9k2">
      <a href="/jobs/view/${4001 + i}/?eBP=x&refId=y">
        <span aria-hidden="true">Java Backend Developer ${i}</span>
        <span class="visually-hidden">Java Backend Developer ${i}</span>
      </a>
      <div class="_2ab8">Acme Technologies</div>
    </div>`;
  return '<!doctype html><html><head><meta charset="utf-8"><title>Jobs | LinkedIn</title></head>'
    + `<body><main>${Array.from({ length: count }, (_, i) => card(i)).join('')}</main></body></html>`;
}

const plan = {
  keywords: ['java developer'], locations: ['Bengaluru'],
  blockMinutes: 15, applyCap: 3, dailyTarget: 20, appliedToday: 0,
  pagesPerSearch: 1, fitMin: 50, phase1Minutes: 5,
  flowConfig: { easyApply: { on: true }, postScan: { on: false }, emailOnly: { on: false }, connections: { on: false } },
};

test('jobs are found on the rewritten results page, with no known class or data attribute', async () => {
  // THE regression. Every card selector is a LinkedIn class or data-* attribute; this fixture
  // has neither. A job card IS an element containing a /jobs/view/<id> link — that is what the
  // thing is, not what it is currently called, so no rename can hide it.
  const { browser, ctx } = await launch({ cookies: LINKEDIN_SESSION });
  const log = captureLog();
  const api = new FakeApi();
  try {
    await new FakeSite()
      .add(/currentJobId=\d+/, (url) => fx.linkedinJob({ id: url.match(/currentJobId=(\d+)/)[1] }))
      .add(/jobs\/search/, () => hashedResults(3))
      .install(ctx);
    const page = await ctx.newPage();
    await runLinkedIn(page, api, plan, makeState(), ctx);
  } finally { log.restore(); await browser.close().catch(() => {}); }

  const text = log.text();
  assert.ok(!/0 Easy-Apply jobs/.test(text),
    `the rewritten page must not read as empty:\n${text.slice(0, 400)}`);
  assert.ok(api.eventsOfType('job_identified').length > 0,
    `no jobs were identified on a page containing three:\n${text.slice(0, 400)}`);
});

test('the search goes to the URL LinkedIn actually serves', async () => {
  // /jobs/search/ redirects to /jobs/search-results and DROPS query parameters on the way —
  // the location filter among them. 545 such redirects in one run. Asking for the destination
  // directly keeps the filters intact.
  const { browser, ctx } = await launch({ cookies: LINKEDIN_SESSION });
  const seen = [];
  const log = captureLog();
  try {
    const site = new FakeSite()
      .add(/currentJobId=\d+/, (url) => fx.linkedinJob({ id: url.match(/currentJobId=(\d+)/)[1] }))
      .add(/jobs\/search/, (url) => { seen.push(url); return hashedResults(1); });
    await site.install(ctx);
    const page = await ctx.newPage();
    await runLinkedIn(page, new FakeApi(), plan, makeState(), ctx);
  } finally { log.restore(); await browser.close().catch(() => {}); }

  const searches = seen.filter((u) => !/currentJobId/.test(u));
  assert.ok(searches.length > 0, 'no search was performed at all');
  assert.ok(searches.some((u) => /\/jobs\/search-results\//.test(u)),
    `must request /jobs/search-results/:\n${searches.slice(0, 3).join('\n')}`);
  assert.ok(searches.some((u) => /location=Bengaluru/i.test(u)),
    `the location filter must survive:\n${searches.slice(0, 3).join('\n')}`);
});
