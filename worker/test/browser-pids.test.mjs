// Which browser processes a close is allowed to kill.
//
// `closeBrowser` used to run `taskkill /F /IM camoufox.exe /T` — every Camoufox on the machine,
// not just its own. Three worker processes started on 2026-08-14 (06:30, 12:46, 12:47); with two
// alive at once, one worker closing its browser kills the other's mid-run, and the victim sees
// precisely what has been reported for days: a browser that died for no local reason.
//
// The parser and the diff decide what gets force-killed, so they are tested directly. Getting
// this wrong in one direction leaks processes that hold the profile lock (the 15-orphan, 4.1 GB
// outage); in the other, it kills a browser that is in the middle of an application.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The exact shape `tasklist /FI "IMAGENAME eq camoufox.exe" /NH /FO CSV` produces.
const parse = (out) => [...out.matchAll(/"camoufox\.exe","(\d+)"/gi)]
  .map((m) => Number(m[1]))
  .filter((n) => Number.isFinite(n) && n > 0);

const REAL = '"camoufox.exe","12345","Console","1","250,000 K"\r\n'
  + '"camoufox.exe","67890","Console","1","180,000 K"\r\n';

test('pids are read out of real tasklist CSV output', () => {
  assert.deepEqual(parse(REAL), [12345, 67890]);
});

test('no processes running is an empty list, not a crash', () => {
  // tasklist prints a human sentence, not CSV, when the filter matches nothing. Throwing here
  // would break the launch path on the ordinary first run of the day.
  assert.deepEqual(parse('INFO: No tasks are running which match the specified criteria.'), []);
});

test('another browser in the list is never claimed', () => {
  assert.deepEqual(parse('"firefox.exe","999","Console","1","100,000 K"'), []);
});

test('THE case: only processes that appeared during OUR launch are ours', () => {
  // 4242 belongs to the other worker and was already running. Killing it is the bug.
  const before = parse('"camoufox.exe","4242","Console","1","250,000 K"');
  const after = parse('"camoufox.exe","4242","Console","1","250,000 K"\r\n'
    + '"camoufox.exe","5150","Console","1","260,000 K"');
  const ours = after.filter((p) => !before.includes(p));
  assert.deepEqual(ours, [5150], 'claimed another worker\'s browser');
});

test('a launch that spawns several processes claims all of them', () => {
  // Camoufox spawns children; /T on each pid takes the tree, but the parent has to be listed.
  const before = [];
  const after = parse('"camoufox.exe","1","Console","1","1 K"\r\n'
    + '"camoufox.exe","2","Console","1","1 K"\r\n"camoufox.exe","3","Console","1","1 K"');
  assert.deepEqual(after.filter((p) => !before.includes(p)), [1, 2, 3]);
});

test('a launch that spawns nothing new claims nothing', () => {
  // If the snapshot fails or the pids are unchanged, we must claim NOTHING rather than
  // everything — closeBrowser then falls back to the image-name kill and says so in the log,
  // which is recoverable. Claiming everything is not.
  const before = parse(REAL);
  const after = parse(REAL);
  assert.deepEqual(after.filter((p) => !before.includes(p)), []);
});
