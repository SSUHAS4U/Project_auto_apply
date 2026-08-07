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

test('a short lookalike cookie is not mistaken for a session', async () => {
  // The >20-char rule on the loose fallback: `li_at` absent, and a stub value must not pass.
  const ctx = ctxWith([{ name: 'lang_session', value: 'en_US' }]);
  assert.equal(await isLoggedIn(ctx, 'linkedin'), false);
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
