// Per-portal log splitting. Run: node --test src/lib/portalLog.test.mjs
//
// The fixture below is the real shape the worker emits — the ▶ header, the search lines, the
// logSummary block with its separator rules and tally — because the splitter's whole job is to
// cut on those exact markers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'node:module';

// The module under test is TypeScript with only type-level syntax; strip the types by hand
// rather than pulling a compiler into a test that exists to check string handling.
const src = readFileSync(new URL('./portalLog.ts', import.meta.url), 'utf8')
  .replace(/export type PortalKey[^;]+;/, '')
  .replace(/: PortalKey/g, '')
  .replace(/: string\[\]/g, '')
  .replace(/: string \| null/g, '')
  .replace(/: (string|boolean)\b/g, '');
const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);
const { filterPortalLog, hasPortalActivity } = mod;

const DLINE = '═'.repeat(56);
const LOG = [
  '  Automation browser open.',
  '  Connected to JobPilot.',
  '',
  '▶ LINKEDIN — starting',
  '',
  '  ══ Easy Apply — 0/15 done today, 15 to go (max 90m) ══',
  '  🔎 java developer · Bengaluru → 12 result(s)',
  '  ▸ Java Backend Developer  ·  Acme   (fit 88)',
  '     ✅ Submitted',
  '',
  DLINE,
  '  Linkedin block complete',
  '    ✅ 1 submitted      ⏸ 0 need you      ✋ 0 manual      ⤼ 2 skipped      ✗ 0 failed',
  DLINE,
  '',
  '▶ INDEED — starting',
  '',
  '  Indeed — 0/20 done today, 20 to go · 120min block · in.indeed.com',
  '  Searching 12 term(s) × 6 location(s) = 72 searches',
  '  🔎 java developer · Bengaluru → 15 result(s)',
  '     ✅ Submitted',
  '',
  DLINE,
  '  Indeed block complete',
  '    ✅ 1 submitted      ⏸ 0 need you      ✋ 0 manual      ⤼ 0 skipped      ✗ 0 failed',
  DLINE,
  '',
  '  Idle — waiting for a run',
].join('\n');

test('the LinkedIn view carries LinkedIn and never Indeed', () => {
  const v = filterPortalLog(LOG, 'linkedin');
  assert.ok(v.includes('Easy Apply — 0/15'), 'must keep its own block');
  assert.ok(v.includes('Linkedin block complete'), 'must keep its own summary');
  assert.ok(v.includes('⤼ 2 skipped'), 'the tally follows the summary line and must survive');
  assert.ok(!v.includes('▶ INDEED'), 'must not carry the Indeed header');
  assert.ok(!v.includes('72 searches'), 'must not carry Indeed body lines');
  assert.ok(!v.includes('Indeed block complete'), 'must not carry the Indeed summary');
});

test('the Indeed view carries Indeed and never LinkedIn', () => {
  const v = filterPortalLog(LOG, 'indeed');
  assert.ok(v.includes('72 searches'));
  assert.ok(v.includes('Indeed block complete'));
  assert.ok(!v.includes('▶ LINKEDIN'));
  assert.ok(!v.includes('Easy Apply — 0/15'));
  assert.ok(!v.includes('⤼ 2 skipped'), "LinkedIn's tally must not leak in");
});

test('shared startup and idle lines appear in both views', () => {
  for (const p of ['linkedin', 'indeed']) {
    const v = filterPortalLog(LOG, p);
    assert.ok(v.includes('Automation browser open.'), `${p} lost the startup line`);
    assert.ok(v.includes('Connected to JobPilot.'), `${p} lost the connection line`);
    assert.ok(v.includes('Idle — waiting for a run'), `${p} lost the trailing idle line`);
  }
});

test('a block still running is attributed even with no summary yet', () => {
  const live = '▶ INDEED — starting\n  Searching 72 searches\n  🔎 one · two → 3 result(s)';
  assert.ok(filterPortalLog(live, 'indeed').includes('🔎'));
  assert.equal(filterPortalLog(live, 'linkedin').trim(), '');
});

test('an empty log stays empty rather than throwing', () => {
  assert.equal(filterPortalLog('', 'indeed'), '');
  assert.equal(filterPortalLog('', 'linkedin'), '');
});

test('output with no portal markers at all is shown to both', () => {
  const pre = '  Automation browser open.\n  ! Could not reach the backend.';
  assert.equal(filterPortalLog(pre, 'indeed'), pre);
  assert.equal(filterPortalLog(pre, 'linkedin'), pre);
});

test('hasPortalActivity reports whether that portal has run', () => {
  assert.equal(hasPortalActivity(LOG, 'linkedin'), true);
  assert.equal(hasPortalActivity(LOG, 'indeed'), true);
  assert.equal(hasPortalActivity('  Automation browser open.', 'indeed'), false);
  assert.equal(hasPortalActivity('▶ LINKEDIN — starting', 'indeed'), false);
});

test('every line is accounted for by exactly one view, or shared by both', () => {
  // No line may vanish: the union of the two views must cover the whole stream.
  const a = new Set(filterPortalLog(LOG, 'linkedin').split('\n'));
  const b = new Set(filterPortalLog(LOG, 'indeed').split('\n'));
  for (const line of LOG.split('\n')) {
    assert.ok(a.has(line) || b.has(line), `line dropped from both views: ${JSON.stringify(line)}`);
  }
});
