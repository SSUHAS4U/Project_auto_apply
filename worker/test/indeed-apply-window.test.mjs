// Indeed's application opens in a SEPARATE WINDOW. Does the adapter actually drive it?
//
// No test had ever asked. Every Indeed fixture navigated the same page with `location.href`, so
// the new-window path — the one real Indeed uses — was exercised by nothing, and 140 tests
// passed while the feature was dead. In production it failed exactly there: the adapter raced
// `ctx.waitForEvent('page')` against the click on a 6-second timeout, missed the window, and
// spent twelve steps driving the SEARCH page. The evidence is unambiguous — the flow "ended" at
// in.indeed.com/jobs offering "Find jobs | Pay | Remote | Distance 1 | Job type", which is
// search chrome, while the real application sat open beside it. Indeed has never submitted a
// single application, and this is why.
//
// `indeedApply` is driven DIRECTLY rather than through runIndeed. Reaching it the long way costs
// minutes per assertion, which is precisely why nobody ever did — the cost of the test is what
// let the bug live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { indeedApply } from '../src/portals/indeed.js';
import { FakeSite, FakeApi, launch, captureLog, makeState } from './harness.mjs';
import * as fx from './fixtures.mjs';

const PROFILE = { fullName: 'S Suhas', email: 'a@b.com', phone: '9999999999', city: 'Bengaluru' };

/** Serve a job page whose Apply button opens the flow in a new window, plus the flow itself. */
async function openJob(ctx, page, { applyWindow = true, apply = 'indeed' } = {}) {
  await new FakeSite()
    .add(/\/smartapply/, (url) => fx.indeedApplyStep({
      step: Number(url.match(/[?&]step=(\d+)/)?.[1] || 1),
      jk: url.match(/jk=([^&]+)/)?.[1] || 'jk1',
    }))
    .add(/[?&]vjk=/, () => fx.indeedJob({ jk: 'jk1', applyWindow, apply }))
    .install(ctx);
  await page.goto('https://in.indeed.com/jobs?q=java&vjk=jk1');
  return page;
}

test('THE case: a new-window application is found, driven and SUBMITTED', async () => {
  const { ctx, browser } = await launch();
    const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await openJob(ctx, page);
    const baseline = ctx.pages().length;
    const log = captureLog();
    const state = makeState();
    const result = await indeedApply(page, new FakeApi(), PROFILE, state, ctx, 'jk1');
    log.restore();

    assert.equal(result, 'applied',
      `the application was not submitted (got "${result}", reason: `
      + `${state.attentionReason || 'none recorded'})\n${log.text()}`);
    // The window must be gone. Production leaked one per job — that is the pile of browser
    // windows on screen, and memory a persistent context never reclaims.
    assert.equal(ctx.pages().length, baseline,
      `${ctx.pages().length - baseline} application window(s) left open`);
  } finally { await browser.close(); }
});

test('a same-window application still works', async () => {
  // Indeed serves both shapes. Fixing the new-window case must not break the other one.
  const { ctx, browser } = await launch();
    const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await openJob(ctx, page, { applyWindow: false });
    const log = captureLog();
    const state = makeState();
    const result = await indeedApply(page, new FakeApi(), PROFILE, state, ctx, 'jk1');
    log.restore();
    assert.equal(result, 'applied',
      `same-window flow broke (got "${result}", reason: ${state.attentionReason})\n${log.text()}`);
  } finally { await browser.close(); }
});

test('the resume step is passed WITHOUT uploading anything', async () => {
  // Indeed already holds the resume — the owner's standing rule is that JobPilot never uploads
  // one, only checks. The fixture's step 2 is the "Add or update your resume" screen that was
  // photographed sitting untouched, and it carries a real file input. If anything ever re-adds
  // setInputFiles, that input holds a file and this fails.
  const { ctx, browser } = await launch();
    const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await openJob(ctx, page);
    const log = captureLog();
    await indeedApply(page, new FakeApi(), PROFILE, makeState(), ctx, 'jk1');
    log.restore();
    // Check every page that existed during the flow, not just the last one.
    for (const p of ctx.pages()) {
      const files = await p.evaluate(() => {
        const el = document.querySelector('input[type=file]');
        return el ? el.files.length : 0;
      }).catch(() => 0);
      assert.equal(files, 0, 'a resume was uploaded — Indeed already has one');
    }
  } finally { await browser.close(); }
});

test('a job with no Indeed Apply button is external, not a crash', async () => {
  const { ctx, browser } = await launch();
    const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await openJob(ctx, page, { apply: 'external' });
    const baseline = ctx.pages().length;
    const log = captureLog();
    const result = await indeedApply(page, new FakeApi(), PROFILE, makeState(), ctx, 'jk1');
    log.restore();
    assert.equal(result, 'external');
    assert.equal(ctx.pages().length, baseline, 'leaked a window on the external path');
  } finally { await browser.close(); }
});

test('a paused run closes the application window before it stops', async () => {
  // The early exits are where the leaks were: paused, blocked and unanswerable-question all
  // returned without closing. Pause is the one that can be forced deterministically.
  const { ctx, browser } = await launch();
    const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await openJob(ctx, page);
    const baseline = ctx.pages().length;
    const state = makeState();
    state.paused = true;
    const log = captureLog();
    const result = await indeedApply(page, new FakeApi(), PROFILE, state, ctx, 'jk1');
    log.restore();
    assert.equal(result, 'attention');
    assert.equal(ctx.pages().length, baseline,
      'a paused run left the application window open — one per paused job');
  } finally { await browser.close(); }
});
