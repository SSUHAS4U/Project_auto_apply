// The account-safety limits. These guard a real consequence, not a preference.
//
// On 2026-08-18 LinkedIn restricted the owner's account:
//
//   "We restricted your account because we detected that over time, it has accessed an
//    unusually high volume of LinkedIn profile data."
//
// The run logs say exactly what did it:
//
//   13 Aug   398 contact-info overlays, 1807 profile page loads
//   14 Aug   272 contact-info overlays, 1222 profile page loads
//
// One function. `emailFromProfile` opened each post author's profile, then the
// `/overlay/contact-info/` panel, then the profile again — three loads per author — and the
// dedicated email flow called it with `cap = Infinity`. Nobody opens four hundred contact-detail
// panels a day by hand. That is not browsing quickly; it is a signature.
//
// These assertions are on the SOURCE rather than on behaviour, deliberately. The failure mode
// they prevent is somebody restoring a convenient line — the overlay is genuinely the better
// place to find an address — without knowing it cost the owner their account for a day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../src/portals/linkedin.js', import.meta.url), 'utf8');
// Comments are allowed to mention it; code is not.
const CODE = SRC.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n');

test('THE case: the contact-info overlay is never requested', () => {
  assert.ok(!/overlay\/contact-info/.test(CODE),
    'the contact-info overlay is being fetched again — 398 of these in one day is what got the '
    + 'account restricted');
});

test('a profile is opened ONCE per author, not three times', () => {
  const i = CODE.indexOf('async function emailFromProfile');
  assert.ok(i > 0, 'emailFromProfile not found');
  const body = CODE.slice(i, CODE.indexOf('\n}', i));
  const gotos = (body.match(/\.goto\(/g) || []).length;
  assert.equal(gotos, 1,
    `emailFromProfile navigates ${gotos} times per author; it used to be 3, which is how 400 `
    + 'authors became 1200 profile loads');
});

test('the profile budget is finite and small', () => {
  const m = SRC.match(/const PROFILE_BUDGET = (\d+)/);
  assert.ok(m, 'PROFILE_BUDGET is gone');
  const budget = Number(m[1]);
  assert.ok(budget > 0 && budget <= 25,
    `PROFILE_BUDGET is ${budget} — the restriction came from volume, and this is the ceiling`);
});

test('the budget counts across the whole process, not per run', () => {
  // LinkedIn's own wording is "over time". A per-run counter resets every block and adds up to
  // the same number by the end of the day, which is the number that triggered the restriction.
  const i = SRC.indexOf('let profilesOpened');
  assert.ok(i > 0, 'the counter is gone');
  const before = SRC.slice(0, i);
  assert.ok(!/function .*\{[^}]*$/.test(before.slice(-200)),
    'profilesOpened looks scoped inside a function — it must be module-level to persist');
});

test('the lead cap is not Infinity', () => {
  assert.ok(!/const cap = dedicated \? Infinity/.test(CODE),
    'the email flow is uncapped again — "uncapped" is what ran until the clock stopped it, '
    + 'and the site counts requests rather than minutes');
});

test('there is a real gap between profile visits', () => {
  const i = CODE.indexOf('async function emailFromProfile');
  const body = CODE.slice(i, CODE.indexOf('\n}', i));
  const delays = [...body.matchAll(/humanDelay\((\d+),\s*(\d+)\)/g)].map((m) => Number(m[1]));
  assert.ok(delays.some((d) => d >= 5000),
    'no meaningful pause between profile visits — three a minute reads as a person, twenty '
    + 'reads as a script');
});
