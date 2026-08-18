// The browser has to be recycled, and the request has to survive the journey.
//
// Measured on the owner's machine rather than assumed:
//
//   baseline (browser + 1 page)      491 MB across  7 processes
//   per abandoned application window 204 MB and 1.3 processes
//   free RAM                        ~5 GB
//   → windows before memory is gone  ~25
//
// A single run left ~24 application windows open, which is ~50 minutes of work — squarely
// inside the 20-to-60-minute window in which the browser has been dying. Idleness was ruled out
// separately: two Camoufox instances left alone for 14 minutes, one pinged and one untouched,
// both survived. So the death is memory, and closing the windows is only half the fix — after
// closing all twelve, 1.7 GB of the 2.4 GB never came back.
//
// The danger in the implementation is not the threshold, it is the JOURNEY: the recycle request
// is an exception raised between jobs, and it has to travel out through two catch blocks that
// exist specifically to swallow exceptions so one bad posting cannot end a block. Both swallowed
// it when first written. That is what these tests hold in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RECYCLE_SIGNAL, BROWSER_MEMORY_LIMIT_MB, FREE_MEMORY_FLOOR_MB,
  freeMemoryMB } from '../src/browser.js';

const SRC = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

test('the limit leaves room to start the replacement', () => {
  // Recycling with no memory left to launch the new browser is not recycling, it is dying with
  // extra steps. 2500 MB is half the measured free RAM and five times the idle baseline.
  assert.ok(BROWSER_MEMORY_LIMIT_MB >= 1500 && BROWSER_MEMORY_LIMIT_MB <= 3500,
    `limit ${BROWSER_MEMORY_LIMIT_MB} MB is outside the range the measurements support`);
});

test('THE case: the per-job catch re-throws the recycle instead of counting a failed job', () => {
  // Both portals wrap each job in a catch that swallows everything, so one bad posting cannot
  // end the block. Correct for a posting; fatal for this signal — swallowed, the recycle never
  // happens and the browser grows to exactly the size it exists to prevent.
  for (const f of ['portals/indeed.js', 'portals/linkedin.js']) {
    const src = SRC(f);
    const catches = src.split('} catch (e) {').slice(1);
    const jobCatch = catches.find((c) => /tally\.failed\+\+/.test(c.slice(0, 900)));
    assert.ok(jobCatch, `${f}: could not find the per-job catch`);
    const head = jobCatch.slice(0, jobCatch.indexOf('tally.failed++'));
    assert.match(head, /RECYCLE_SIGNAL/,
      `${f}: the per-job catch swallows the recycle request`);
    assert.match(head, /throw e/,
      `${f}: the per-job catch never re-throws`);
  }
});

test('the per-flow catch re-throws it too', () => {
  // Post scan, recruiter email and connections each run inside runFlow's own catch. Swallowed
  // there, the block would walk through all three in seconds — each one re-raising and being
  // swallowed again — and finish having done none of them.
  // Read to the END of runFlow, not a fixed number of characters from its start. The first
  // version sliced 2200 chars and passed — until FLOW_STARVED added an explanation to the
  // silent-skip branch, which pushed the catch past the window and failed a test about code
  // nobody had touched. A test whose result depends on how much commentary sits above the
  // thing it checks is measuring the wrong property.
  const src = SRC('portals/linkedin.js');
  const i = src.indexOf('const runFlow = async (key, fn)');
  assert.ok(i > 0, 'runFlow not found');
  const end = src.indexOf(String.fromCharCode(10) + '    };', i);
  assert.ok(end > i, 'could not find the end of runFlow');
  const body = src.slice(i, end);
  assert.match(body, /RECYCLE_SIGNAL/, 'runFlow swallows the recycle request');
});

test('a dead browser also escapes both catches', () => {
  // Same journey, same stakes: index.js can only relaunch and continue the block if the error
  // reaches it. Counted as a failed job, the block grinds on against a browser that is gone —
  // which is how 70 consecutive searches once reported "0 Easy-Apply jobs" in silence.
  for (const f of ['portals/indeed.js', 'portals/linkedin.js']) {
    assert.match(SRC(f), /target page, context or browser has been closed/i,
      `${f}: a dead browser is not re-thrown from the per-job catch`);
  }
});

test('index.js does not spend death retries on planned recycles', () => {
  // A block gets three attempts at a crashed browser. If a recycle consumed one, a long block
  // would burn all three on planned restarts and have none left for a real crash.
  const src = SRC('index.js');
  assert.match(src, /if \(recycling\) recycles\+\+/, 'recycles are not counted separately');
  assert.match(src, /if \(!recycling\) attempt\+\+/, 'a recycle still consumes a death attempt');
});

test('the signal is a distinct string, not a substring of a real error', () => {
  // Matched with ===, so a stray error whose text merely contains it cannot trigger a recycle,
  // and a change to the wording cannot silently stop recycling either.
  assert.match(RECYCLE_SIGNAL, /^jobpilot:/);
  assert.ok(RECYCLE_SIGNAL.length > 20);
});

test('a small browser on a busy machine does NOT trigger an endless recycle loop', () => {
  // The free-memory floor exists for the case a fixed browser limit cannot see: the MACHINE
  // running out because of everything else that is open. But if the browser is small, restarting
  // it frees nothing and the run would recycle on every single job forever. Both portals gate
  // the floor behind the browser actually being worth recycling.
  const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  for (const f of ['portals/indeed.js', 'portals/linkedin.js']) {
    const body = src(f).slice(src(f).indexOf('async function recycleIfBloated'));
    assert.match(body.slice(0, 1400), /worthRecycling/,
      `${f}: the free-memory floor is not gated on the browser being the cause`);
  }
});

test('the floor leaves room to actually start the replacement', () => {
  // A launch needs roughly the 491 MB idle baseline. Recycling at less than that is recycling
  // with no memory to recycle into — Camoufox failed to start in this suite at 2.17 GB resident
  // with "gBrowser never populated", which is exactly that failure.
  assert.ok(FREE_MEMORY_FLOOR_MB >= 800,
    `${FREE_MEMORY_FLOOR_MB} MB is below the memory a launch needs`);
  assert.ok(FREE_MEMORY_FLOOR_MB < BROWSER_MEMORY_LIMIT_MB,
    'the floor must trip before the browser limit on a memory-starved machine');
});

test('free memory reads a real number', () => {
  const mb = freeMemoryMB();
  assert.ok(Number.isFinite(mb) && mb > 0, `freeMemoryMB() returned ${mb}`);
});
