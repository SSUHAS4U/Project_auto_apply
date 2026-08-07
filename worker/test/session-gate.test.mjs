// The headless decision, which is what turned an expired cookie into "the automation is broken".
//
// Reported symptom: LinkedIn printed "▶ LINKEDIN — starting" and then, with no delay and no
// reason, a 0/0/0 summary. The dashboard carried an event saying "Open the automation browser,
// log into linkedin.com once" — advice that could not be followed, because the app was running
// headless and there was no window to open. Indeed was still signed in, and the startup check
// is an OR across portals, so `anyPortalLoggedIn` said yes and the window never appeared.
//
// These tests are about that OR, and about the per-portal check that replaced it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoggedIn, anyPortalLoggedIn, loginUrl } from '../src/connections.js';

/** A stand-in for the persistent context: just the cookie jar, which is all these read. */
const ctxWith = (cookies) => ({ cookies: async () => cookies });

const LI = { name: 'li_at', value: 'AQEDAT' + 'x'.repeat(40) };
const IN = { name: 'PPID', value: 'eyJhbGciOi' + 'y'.repeat(40) };

test('a live Indeed session does NOT make LinkedIn look signed in', async () => {
  // The exact production state that produced the silent 0/0/0 block.
  const ctx = ctxWith([IN]);
  assert.equal(await isLoggedIn(ctx, 'indeed'), true);
  assert.equal(await isLoggedIn(ctx, 'linkedin'), false,
    'an Indeed cookie must never satisfy the LinkedIn check');
  assert.equal(await anyPortalLoggedIn(ctx), true,
    'anyPortalLoggedIn is still true here — which is why the per-portal check has to exist');
});

test('an empty jar is signed out everywhere', async () => {
  const ctx = ctxWith([]);
  assert.equal(await isLoggedIn(ctx, 'linkedin'), false);
  assert.equal(await isLoggedIn(ctx, 'indeed'), false);
  assert.equal(await anyPortalLoggedIn(ctx), false);
});

test('a present-but-empty auth cookie counts as signed out', async () => {
  // LinkedIn blanks li_at on logout rather than deleting it. Name-only matching read that as
  // a live session and sent the run at a signed-out job search.
  assert.equal(await isLoggedIn(ctxWith([{ name: 'li_at', value: '' }]), 'linkedin'), false);
});

test('a signed-out LinkedIn visitor is NOT reported as signed in', async () => {
  // THE bug. isLoggedIn fell back to "any long-lived session-ish cookie name":
  //     /(_at|session|SID|login|auth)/i.test(c.name) && c.value.length > 20
  // `SID` matches JSESSIONID, which LinkedIn hands to anonymous visitors. So a signed-out
  // profile read as connected: the card showed Active, the gate that opens a login window
  // never fired, and the run finished 0/0/0 against a signed-out job search.
  // These are the cookies a real signed-out linkedin.com visit leaves behind.
  const signedOut = [
    { name: 'JSESSIONID', value: '"ajax:8374652019384756201"' },
    { name: 'bcookie', value: '"v=2&8f3c1a90-4b2e-4f77-9d21-0c8e5a6b3d19"' },
    { name: 'bscookie', value: '"v=1&2026' + 'a'.repeat(60) + '"' },
    { name: 'lidc', value: 'b=OGST04:s=O:r=O:a=O:p=O:g=3021:u=1' },
    { name: 'li_gc', value: 'MTsyMTsxNzY0NTAwMDAwOzI7MDIx' + 'b'.repeat(30) },
    { name: 'lang', value: 'v=2&lang=en-us' },
  ];
  assert.equal(await isLoggedIn(ctxWith(signedOut), 'linkedin'), false,
    'no li_at means signed out, whatever else is in the jar');
  // And each one individually — any single false positive is enough to reproduce the bug.
  for (const c of signedOut) {
    assert.equal(await isLoggedIn(ctxWith([c]), 'linkedin'), false, `${c.name} must not imply a session`);
  }
});

test('a signed-out Indeed visitor is NOT reported as signed in', async () => {
  const signedOut = [
    { name: 'CTK', value: '1hq7k9c2ljd0d800' },
    { name: 'INDEED_CSRF_TOKEN', value: 'Zt4mQ9xLpR2vN8kD' + 'c'.repeat(30) },
    { name: 'SHOE', value: 'bK4mLpQ2xR9vN' + 'd'.repeat(40) },
    { name: 'SOCK', value: 'eyJhbGciOiJIUzI1NiJ9' + 'e'.repeat(40) },
  ];
  assert.equal(await isLoggedIn(ctxWith(signedOut), 'indeed'), false);
  assert.equal(await anyPortalLoggedIn(ctxWith(signedOut)), false,
    'a signed-out jar must not keep the app headless');
});

test('the real auth cookie still counts, even in a crowded jar', async () => {
  // The walls must not be so tight that a genuine session reads as signed out — that failure
  // mode sends someone re-authenticating a session that was fine.
  const jar = [{ name: 'JSESSIONID', value: '"ajax:123"' }, { name: 'lidc', value: 'b=OGST04' }, LI];
  assert.equal(await isLoggedIn(ctxWith(jar), 'linkedin'), true);
});

test('both signed in is signed in for each, independently', async () => {
  const ctx = ctxWith([LI, IN]);
  assert.equal(await isLoggedIn(ctx, 'linkedin'), true);
  assert.equal(await isLoggedIn(ctx, 'indeed'), true);
});

test('an unreadable cookie jar fails closed', async () => {
  // A closed context throws here. "We could not tell" must not mean "signed in", or the run
  // proceeds headless against a session that may not exist.
  const ctx = { cookies: async () => { throw new Error('Target page, context or browser has been closed'); } };
  assert.equal(await isLoggedIn(ctx, 'linkedin'), false);
  assert.equal(await anyPortalLoggedIn(ctx), false);
});

test('an unknown portal is signed out, not a crash', async () => {
  assert.equal(await isLoggedIn(ctxWith([LI]), 'glassdoor'), false);
});

test('every portal has a real login URL to send someone to', () => {
  for (const p of ['linkedin', 'indeed']) {
    assert.match(loginUrl(p), /^https:\/\//, `${p} needs a usable login URL`);
  }
  // Unknown portal still yields somewhere to go rather than `undefined`, which would make
  // page.goto throw and leave a blank window with no explanation.
  assert.match(loginUrl('nope'), /^https:\/\//);
});

// ---- Connect must survive its own failures ------------------------------------
//
// Connect was a button that did nothing. The backend deleted the request the moment the
// worker READ it, so anything failing afterwards — a browser that would not relaunch, a
// locked profile directory, a dead context — threw the click away, while the worker's
// `catch { /* ignore */ }` made sure nobody ever learned why. The card sat on "Waiting for
// sign-in…" and pressing Connect again just repeated the loss.
import { handleConnectionActions, resetConnectThrottle } from '../src/connections.js';

/** Records acks the way the backend would, so "did it confirm?" is assertable. */
function ackApi(actions) {
  return {
    acks: [],
    sessions: [],
    async connectionActions() { return actions; },
    async connectionAck(portal, ok, detail) { this.acks.push({ portal, ok, detail }); },
    async session(portal, loggedIn, detail) { this.sessions.push({ portal, loggedIn, detail }); },
  };
}

const quiet = () => {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  return { text: () => lines.join('\n'), restore: () => { console.log = orig; } };
};

test('a connect that cannot open a window is NOT acknowledged', async () => {
  resetConnectThrottle();
  const api = ackApi([{ portal: 'linkedin', action: 'connect' }]);
  const log = quiet();
  try {
    // The exact production failure: the relaunch throws (profile still locked).
    await handleConnectionActions(null, null, api, async () => {
      throw new Error('Failed to launch: profile is already in use');
    });
  } finally { log.restore(); }

  assert.equal(api.acks.length, 1);
  assert.equal(api.acks[0].ok, false,
    'a failed connect must not be acknowledged — the backend keeps it queued and retries');
  assert.match(api.acks[0].detail, /profile is already in use/,
    'the reason must reach the card instead of vanishing');
  assert.match(log.text(), /Could not open the linkedin login window/i,
    'and it must be said out loud, not swallowed');
});

test('a connect that opens the login page IS acknowledged', async () => {
  // The other direction: the walls must not be so tight that a working connect never clears,
  // which would leave it retrying forever and reopening windows.
  let navigated = '';
  const ctx = {
    async newPage() {
      return {
        bringToFront: async () => {},
        goto: async (u) => { navigated = u; },
      };
    },
    async cookies() { return []; },
  };
  resetConnectThrottle();
  const api = ackApi([{ portal: 'linkedin', action: 'connect' }]);
  const log = quiet();
  try { await handleConnectionActions(ctx, null, api, async () => ctx); } finally { log.restore(); }

  assert.match(navigated, /linkedin\.com\/login/, 'it must land on the real login page');
  assert.deepEqual(api.acks.map((a) => [a.portal, a.ok]), [['linkedin', true]]);
});

test('a blank login tab is a failure, not a success', async () => {
  // goto() used to be wrapped in .catch(() => {}), so a navigation that never happened still
  // counted as a successful Connect and cleared the request.
  const ctx = {
    async newPage() {
      return {
        bringToFront: async () => {},
        goto: async () => { throw new Error('NS_ERROR_UNKNOWN_HOST'); },
      };
    },
  };
  resetConnectThrottle();
  const api = ackApi([{ portal: 'indeed', action: 'connect' }]);
  const log = quiet();
  try { await handleConnectionActions(ctx, null, api, async () => ctx); } finally { log.restore(); }
  assert.equal(api.acks[0].ok, false, 'a tab that never loaded must not clear the request');
});

test('one failing portal does not stop the other from connecting', async () => {
  let opened = 0;
  const ctx = {
    async newPage() {
      opened++;
      return { bringToFront: async () => {}, goto: async () => { if (opened === 1) throw new Error('boom'); } };
    },
  };
  resetConnectThrottle();
  const api = ackApi([
    { portal: 'linkedin', action: 'connect' },
    { portal: 'indeed', action: 'connect' },
  ]);
  const log = quiet();
  try { await handleConnectionActions(ctx, null, api, async () => ctx); } finally { log.restore(); }
  assert.deepEqual(api.acks.map((a) => [a.portal, a.ok]), [['linkedin', false], ['indeed', true]]);
});

test('an empty action list acks nothing and does nothing', async () => {
  const api = ackApi([]);
  const log = quiet();
  try { assert.equal(await handleConnectionActions(null, null, api, async () => null), false); }
  finally { log.restore(); }
  assert.deepEqual(api.acks, []);
});

// ---- Easy Apply control matching ---------------------------------------------
//
// The live log showed a modal whose buttons were printed as present and on-screen:
//   Dismiss | Review job post | I understand the tips and want to continue the apply process
//   Continue applying
// and the run still reported "the Easy Apply form has no Submit/Continue control we
// recognise", handing a fit-78 job to a human. Two faults met there.

/** The matcher exactly as the page-side code builds it. */
const matches = (src, label) => new RegExp(src).test(label);
const NEVER = /review job post|^dismiss|^back\b|^discard|save (?:and )?(?:exit|for later)|^cancel/;

const BS = String.fromCharCode(8);   // U+0008 — see the first test
const NEXT = 'continue applying|continue to next step|review your application'
  + '|^continue$|^next$|^review$|^continue\\b|^next\\b|^review\\b';
const SUBMIT = '^submit application|^submit\\b|submit application';

test('a backslash-b in a JS string was a backspace, killing three of five alternatives', () => {
  // The bug, pinned so it cannot come back. In a JS string literal, backslash-b is U+0008 — a
  // backspace character — not the regex word boundary it reads as. So '^submit\\b' compiled to
  // "^submit<BACKSPACE>" and could never match anything. Three of the five alternatives the
  // adapter shipped were dead on arrival, silently, and only the ones written without \\b
  // ever did any work.
  //
  // Built from its code point on purpose: written as a literal, an editor or shell would
  // "helpfully" repair the very thing under test.
  const broken = '^review' + BS;
  assert.equal(broken.charCodeAt(7), 8, 'the literal really does carry a backspace');
  assert.equal(matches(broken, 'review'), false, 'so it matched nothing at all');
  // Correctly escaped — a real backslash reaches RegExp — it is a word boundary and behaves.
  assert.equal(matches('^review\\b', 'review'), true);
  assert.equal(matches('^review\\b', 'reviewer of things'), false);
  // And the patterns the adapter actually ships must be of the escaped kind.
  assert.ok(!NEXT.includes(BS), 'the advance pattern must not carry a backspace');
  assert.ok(!SUBMIT.includes(BS), 'the submit pattern must not carry a backspace');
});

test('the safety-tips interstitial is recognised as an advance', () => {
  // Not anchored: the real label buries "continue applying" right at the end.
  const label = 'i understand the tips and want to continue the apply process continue applying';
  assert.ok(!NEVER.test(label));
  assert.ok(matches(NEXT, label), 'this exact button left a fit-78 job unapplied');
});

test('"Review job post" is never clicked as an advance', () => {
  // It matches /^review\b/ perfectly well now that the boundary works — and clicking it
  // navigates out of the apply flow, losing the half-filled form. The deny-list is what
  // has to stop it, which is why that check runs BEFORE the pattern.
  assert.ok(matches(NEXT, 'review job post'), 'it does match the advance pattern...');
  assert.ok(NEVER.test('review job post'), '...so only the deny-list prevents the click');
});

test('the other escape hatches in the modal are denied too', () => {
  for (const l of ['dismiss', 'back to job', 'discard', 'save for later', 'cancel']) {
    assert.ok(NEVER.test(l), `${l} must never count as an advance`);
  }
});

test('the ordinary step and submit buttons still match', () => {
  // The deny-list must not block the normal path — a matcher that recognises nothing is the
  // failure being fixed here, not an improvement on it.
  for (const l of ['continue to next step', 'next', 'review your application', 'review', 'continue']) {
    assert.ok(matches(NEXT, l) && !NEVER.test(l), `advance control not recognised: "${l}"`);
  }
  for (const l of ['submit application', 'submit']) {
    assert.ok(matches(SUBMIT, l), `submit control not recognised: "${l}"`);
  }
  // Submit is tried before next, so "review your application" cannot pre-empt a real submit.
  assert.equal(matches(SUBMIT, 'review your application'), false);
});

test('a stuck connect request does not relaunch the browser every tick', async () => {
  // THE thing that wiped the sign-in. The main loop calls this about every four seconds, and
  // since v133 a request survives until it is acknowledged — correct in itself, but it meant a
  // request whose ack never landed reopened the login window on every tick, and each attempt
  // tears the browser down and rebuilds it. Firefox writes cookies to cookies.sqlite lazily, so
  // a profile cycled that fast never flushes: sign in, and it is gone moments later.
  resetConnectThrottle();
  let windows = 0;
  const ctx = {
    async newPage() { return { bringToFront: async () => {}, goto: async () => {} }; },
    async cookies() { return []; },              // never becomes signed in
  };
  const api = ackApi([{ portal: 'linkedin', action: 'connect' }]);
  api.connectionAck = async () => { throw new Error('backend unreachable'); };  // ack never lands
  const log = quiet();
  try {
    for (let tick = 0; tick < 25; tick++) {      // ~100 seconds of loop ticks
      await handleConnectionActions(ctx, null, api, async () => { windows++; return ctx; });
    }
  } finally { log.restore(); }
  assert.equal(windows, 1, `the browser was relaunched ${windows} times for one Connect click`);
});

test('a completed sign-in ends the request even if the ack was lost', async () => {
  // The other half: once the cookie is there the request is done, whatever the ack did.
  // Without this an ack that failed would keep reopening the login page forever, on top of a
  // session that was already working.
  resetConnectThrottle();
  let windows = 0;
  const ctx = {
    async newPage() { return { bringToFront: async () => {}, goto: async () => {} }; },
    async cookies() { return [{ name: 'li_at', value: 'AQEDAT' + 'x'.repeat(40) }]; },
  };
  const api = ackApi([{ portal: 'linkedin', action: 'connect' }]);
  const log = quiet();
  try { await handleConnectionActions(ctx, null, api, async () => { windows++; return ctx; }); }
  finally { log.restore(); }
  assert.equal(windows, 0, 'an already-signed-in portal must not reopen a login window');
  assert.deepEqual(api.acks.map((a) => [a.portal, a.ok]), [['linkedin', true]]);
  assert.deepEqual(api.sessions.map((s2) => [s2.portal, s2.loggedIn]), [['linkedin', true]]);
});
