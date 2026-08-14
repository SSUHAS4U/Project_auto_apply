// Did the search we asked for actually run?
//
// On 2026-08-14 the answer was no, 72 times, and nothing noticed. Every search asked for a city;
// LinkedIn's SPA rewrote the URL after landing and dropped `location`; the worker read the
// results of a nationwide search and reported them as the city's. Four distinct job ids came
// out of the entire run, each found ten or eleven times over — the same jobs, because it was
// the same search every time.
//
// The URLs below are REAL, copied from that run's log rather than invented, because the whole
// failure was a mismatch between what we asked for and what we got. A fixture I made up would
// have agreed with whatever I believed at the time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locationKept } from '../src/portals/linkedin.js';

// What the worker REQUESTED — location present.
const ASKED = 'https://www.linkedin.com/jobs/search-results/?keywords=Backend+Developer+SQL'
  + '&f_AL=true&sortBy=DD&location=Bengaluru&f_TPR=r2592000';
// What LinkedIn LEFT US ON, seconds later. location and sortBy are gone.
const LANDED = 'https://www.linkedin.com/jobs/search-results/?keywords=Backend+Developer+SQL'
  + '&f_TPR=r2592000&f_AL=true';
// The form that kept them that day.
const KEPT = 'https://www.linkedin.com/jobs/search/?currentJobId=4452910291&f_AL=true'
  + '&f_TPR=r2592000&keywords=Backend%20Developer%20SQL&location=Bengaluru&sortBy=DD';

test('THE case: the rewritten URL is reported as having lost the city', () => {
  assert.equal(locationKept(LANDED, 'Bengaluru'), false,
    'this exact URL ran 73 times as a nationwide search and was reported as Bengaluru');
});

test('the URL we asked for passes', () => {
  assert.equal(locationKept(ASKED, 'Bengaluru'), true);
});

test('percent-encoded and re-ordered params still count as kept', () => {
  // LinkedIn re-encodes and re-orders on the way through. A strict comparison would call this
  // broken and send every search down the retry path — a false alarm in the other direction,
  // which costs a second page load on every search for nothing.
  assert.equal(locationKept(KEPT, 'Bengaluru'), true);
});

test('a fuller place name still matches the city asked for', () => {
  assert.equal(locationKept('https://www.linkedin.com/jobs/search/?location=Bengaluru%2C%20Karnataka%2C%20India',
    'Bengaluru'), true);
});

test('remote is a work-type flag, not a place', () => {
  // Remote sets f_WT=2 and no location at all, so checking for a location name would report
  // every remote search as broken — 1 of every 6 pairs in the matrix.
  assert.equal(locationKept('https://www.linkedin.com/jobs/search-results/?keywords=X&f_WT=2', 'Remote'), true);
  assert.equal(locationKept('https://www.linkedin.com/jobs/search-results/?keywords=X', 'Remote'), false);
});

test('a different city does not count as a match', () => {
  assert.equal(locationKept(LANDED.replace('SQL', 'SQL&location=Pune'), 'Bengaluru'), false);
});

test('empty and malformed input do not throw', () => {
  // This runs on every search; throwing here would take out the phase it is meant to protect.
  assert.equal(locationKept('', 'Bengaluru'), false);
  assert.equal(locationKept(undefined, 'Bengaluru'), false);
  assert.equal(locationKept(LANDED, ''), false);
  assert.equal(locationKept('%%%not a url%%%', 'Bengaluru'), false);
});
