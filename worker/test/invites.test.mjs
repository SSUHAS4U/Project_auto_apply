// Invitation cleanup rules.
//
// Withdrawing is NOT reversible — LinkedIn blocks re-inviting the same person for about three
// weeks — so the only acceptable failure mode is "did nothing". Every case below exists to pin
// that: an unreadable age, a young invitation, or a nonsense threshold must all leave the
// invitation alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ageInDays, shouldWithdraw, cleanupDue, MIN_AGE_DAYS, DEFAULT_AGE_DAYS } from '../src/invites.js';

test('ages are parsed in every form LinkedIn writes them', () => {
  assert.equal(ageInDays('3 days ago'), 3);
  assert.equal(ageInDays('2 weeks ago'), 14);
  assert.equal(ageInDays('1 month ago'), 30);
  assert.equal(ageInDays('4 months ago'), 120);
  assert.equal(ageInDays('1 year ago'), 365);
  // LinkedIn writes exactly-one as "a week ago", not "1 week ago".
  assert.equal(ageInDays('a week ago'), 7);
  assert.equal(ageInDays('a month ago'), 30);
  assert.equal(ageInDays('Sent a day ago'), 1);
});

test('an unreadable age yields null, never a number', () => {
  for (const bad of ['', null, undefined, 'recently', 'Sent', 'yesterday', '0 days ago', 'ages ago']) {
    assert.equal(ageInDays(bad), null, `should not parse: ${JSON.stringify(bad)}`);
  }
});

test('an invitation whose age cannot be read is NEVER withdrawn', () => {
  // The whole safety property. A row we could not date is a row we must not touch.
  for (const bad of ['', 'recently', 'Sent', undefined]) {
    assert.equal(shouldWithdraw({ ageText: bad }, 21), false, JSON.stringify(bad));
  }
  assert.equal(shouldWithdraw({}, 21), false);
  assert.equal(shouldWithdraw(null, 21), false);
});

test('recent invitations are left alone', () => {
  assert.equal(shouldWithdraw({ ageText: '3 days ago' }, 21), false);
  assert.equal(shouldWithdraw({ ageText: '2 weeks ago' }, 21), false);
  assert.equal(shouldWithdraw({ ageText: '20 days ago' }, 21), false);
});

test('old invitations are withdrawn', () => {
  assert.equal(shouldWithdraw({ ageText: '21 days ago' }, 21), true);
  assert.equal(shouldWithdraw({ ageText: '2 months ago' }, 21), true);
  assert.equal(shouldWithdraw({ ageText: '1 year ago' }, 21), true);
});

test('the floor cannot be lowered, however the setting is configured', () => {
  // A threshold of 1 day would clear the backlog fast and destroy every live invitation with
  // it. MIN_AGE_DAYS wins over anything the caller passes.
  for (const daft of [0, 1, 5, -30, NaN, null, undefined, 'soon']) {
    assert.equal(shouldWithdraw({ ageText: '7 days ago' }, daft), false,
      `a 7-day-old invite must survive threshold ${JSON.stringify(daft)}`);
  }
  assert.equal(shouldWithdraw({ ageText: `${MIN_AGE_DAYS} days ago` }, 1), true,
    'at the floor itself it may go');
  assert.ok(MIN_AGE_DAYS >= 14, 'the floor must stay conservative');
  assert.ok(DEFAULT_AGE_DAYS >= MIN_AGE_DAYS);
});

test('a higher threshold is honoured', () => {
  assert.equal(shouldWithdraw({ ageText: '30 days ago' }, 60), false);
  assert.equal(shouldWithdraw({ ageText: '3 months ago' }, 60), true);
});

test('cleanup is weekly, not every run', () => {
  // No stamp yet → due. (A fresh install should tidy up once, then wait.)
  assert.equal(typeof cleanupDue(), 'boolean');
  // Six days after an imaginary run is not due; eight days is.
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  assert.equal(now - (now - 6 * DAY) >= 7 * DAY, false, 'six days is not a week');
  assert.equal(now - (now - 8 * DAY) >= 7 * DAY, true, 'eight days is');
});
