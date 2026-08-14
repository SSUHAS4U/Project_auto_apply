// A block that survives its browser dying.
//
// 2026-08-14: the browser died at minute 56 of a 90-minute Easy Apply phase and again 16
// minutes after the relaunch. Both deadlines were `Date.now() + budget`, computed fresh on
// every attempt, so the retry handed Easy Apply a brand-new 90 minutes — and the block a
// brand-new 210. Post scan, recruiter email and connections were never reached in that run or
// any run before it: Phase 1 could always afford to consume everything, twice over.
//
// These test the arithmetic that decides it, because the arithmetic is the bug. Driving a real
// browser death would test Playwright, not this.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The rule as implemented in runLinkedIn, isolated so it can be exercised directly.
function phase1Window(state, plan, now) {
  const blockMin = Math.max(plan.blockMinutes || 210, 30);
  if (!state.blockStartedAt) state.blockStartedAt = now;
  const deadline = state.blockStartedAt + blockMin * 60_000;
  const budgetMs = Math.max(plan.phase1Minutes || 90, 5) * 60_000;
  const spent = state.phase1SpentMs || 0;
  const phase1Deadline = Math.min(now + Math.max(budgetMs - spent, 0), deadline);
  return { deadline, phase1Deadline, exhausted: spent >= budgetMs,
           phase1Ms: Math.max(phase1Deadline - now, 0) };
}

const PLAN = { blockMinutes: 225, phase1Minutes: 90 };
const M = 60_000;

test('first attempt gets the whole budget', () => {
  const state = {};
  const w = phase1Window(state, PLAN, 1_000_000);
  assert.equal(w.phase1Ms, 90 * M);
  assert.equal(w.exhausted, false);
});

test('THE case: a crash at minute 56 leaves 34 minutes, not another 90', () => {
  const state = { phase1SpentMs: 56 * M, blockStartedAt: 1_000_000 };
  const w = phase1Window(state, PLAN, 1_000_000 + 56 * M);
  assert.equal(w.phase1Ms, 34 * M, 'the retry restarted Easy Apply with a full budget');
});

test('a phase that already spent its budget is skipped so outreach can run', () => {
  // This is the whole point: the flows after Easy Apply have never once executed.
  const state = { phase1SpentMs: 90 * M, blockStartedAt: 1_000_000 };
  const w = phase1Window(state, PLAN, 1_000_000 + 90 * M);
  assert.equal(w.exhausted, true);
  assert.equal(w.phase1Ms, 0);
});

test('overshooting the budget does not produce a negative window', () => {
  // Easy Apply can run slightly past its deadline finishing a job. Without the clamp this went
  // negative, and `Date.now() < phase1Deadline` would then be false forever — harmless here,
  // but the same value is reported to the user as minutes remaining.
  const state = { phase1SpentMs: 97 * M, blockStartedAt: 1_000_000 };
  const w = phase1Window(state, PLAN, 1_000_000 + 97 * M);
  assert.equal(w.phase1Ms, 0);
  assert.equal(w.exhausted, true);
});

test('the block deadline is absolute — a retry does not extend the block', () => {
  const state = {};
  const first = phase1Window(state, PLAN, 1_000_000);
  const afterCrash = phase1Window(state, PLAN, 1_000_000 + 56 * M);
  assert.equal(afterCrash.deadline, first.deadline,
    'the retry gave the block a fresh 225 minutes');
});

test('phase 1 can never outlive the block that contains it', () => {
  // A 90-minute phase inside a 30-minute block must end with the block. Otherwise Easy Apply
  // runs past the point where outreach could have happened at all.
  const state = {};
  const w = phase1Window(state, { blockMinutes: 30, phase1Minutes: 90 }, 1_000_000);
  assert.equal(w.phase1Ms, 30 * M);
});

test('a fresh block starts from zero again', () => {
  // index.js clears these per block. If it did not, the block after a full Easy Apply would
  // open with its budget already spent and skip to outreach forever.
  const state = { phase1SpentMs: 90 * M, blockStartedAt: 1_000_000 };
  state.phase1SpentMs = 0; state.blockStartedAt = 0;      // what index.js does
  const w = phase1Window(state, PLAN, 5_000_000);
  assert.equal(w.exhausted, false);
  assert.equal(w.phase1Ms, 90 * M);
});
