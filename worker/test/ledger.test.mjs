// Run accountability — the guarantee that a run cannot end unexplained.
//
// fault.js covers failures we anticipated. This covers the case that cost the most time: a run
// where NOTHING failed and NOTHING happened. 80 jobs seen, 0 applied, every one "skipped", no
// fault recorded — each skip individually reasonable, the aggregate a broken product, and no
// line anywhere saying so. Every such run had ONE dominant cause that was recorded per job and
// never counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newLedger, record, seal } from '../src/ledger.js';

const capture = () => {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  return { text: () => lines.join('\n'), restore: () => { console.log = orig; } };
};

test('a run that applies to nothing names its dominant cause', () => {
  // The real shape of the run that started a week of guessing: 62 of 80 jobs, one cause.
  const l = newLedger('linkedin');
  for (let i = 0; i < 62; i++) record(l, 'skipped', `stack mismatch (fit ${40 + (i % 20)})`);
  for (let i = 0; i < 12; i++) record(l, 'skipped', 'senior/leadership role');
  for (let i = 0; i < 6; i++) record(l, 'manual', 'external site');

  const log = capture();
  try { seal(l, { applied: 0, searched: 80 }); } finally { log.restore(); }
  const out = log.text();

  assert.match(out, /stack mismatch/i, 'the dominant cause must be named, not just counted');
  assert.match(out, /7[0-9]\s*%/, 'and its share stated');
  assert.match(out, /THAT is the thing to fix/i, 'and pointed at as the thing to fix');
});

test('scores are grouped so one cause is not hidden as twenty', () => {
  // "fit 43" and "fit 57" are the same finding at different scores. Kept apart, 62 jobs with
  // one cause look like twenty unrelated ones — which is exactly how it read for days.
  const l = newLedger('linkedin');
  for (const s of [43, 57, 55, 43, 29, 57]) record(l, 'skipped', `stack mismatch (fit ${s})`);
  assert.equal(l.outcomes.size, 1, `grouped into ${l.outcomes.size} buckets: ${[...l.outcomes.keys()]}`);
  assert.equal([...l.outcomes.values()][0], 6);
});

test('jobs seen but never recorded are reported as a fault', () => {
  // A path that exits without saying why. Those jobs are invisible in every summary.
  const l = newLedger('indeed');
  for (let i = 0; i < 10; i++) record(l, 'skipped', 'stack mismatch');
  const log = capture();
  try { seal(l, { applied: 0, searched: 50 }); } finally { log.restore(); }
  assert.match(log.text(), /never recorded an outcome/i,
    'a 40-job gap must be reported, not silently absorbed');
});

test('a successful run is not accused of achieving nothing', () => {
  // The guard must not fire when the run worked — a warning that cries wolf gets ignored,
  // and then it says nothing on the day it matters.
  const l = newLedger('linkedin');
  for (let i = 0; i < 14; i++) record(l, 'applied', 'submitted');
  for (let i = 0; i < 30; i++) record(l, 'skipped', 'stack mismatch');
  const log = capture();
  try { seal(l, { applied: 14, searched: 44 }); } finally { log.restore(); }
  const out = log.text();
  assert.ok(!/THAT is the thing to fix/i.test(out), 'a working run must not be flagged');
  assert.match(out, /accounted for/i, 'but it still reports where the jobs went');
});

test('a run that opened nothing stays quiet — the search faults own that', () => {
  const l = newLedger('linkedin');
  const log = capture();
  try { seal(l, { applied: 0, searched: 0 }); } finally { log.restore(); }
  assert.equal(log.text().trim(), '', 'nothing to account for means nothing to say');
});
