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
import { handleConnectionActions } from '../src/connections.js';

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
