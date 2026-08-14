import { logEvent } from './logfile.js';
import { record } from './ledger.js';

// Pretty, consistent terminal output for the worker.
//
// The desktop terminal panel renders the worker's raw stdout as plain text — no ANSI colour —
// so all structure here comes from Unicode symbols, indentation and dotted leaders. The goal
// is a log you can SCAN: one clear block per job, aligned question → answer rows, and a tidy
// summary, instead of a wall of repeated lines.

const LINE = '─'.repeat(56);
const DLINE = '═'.repeat(56);

/**
 * The run ledger, set once per block by the adapter.
 *
 * Held here rather than threaded through every function because logResult and logSkipped are
 * already the two places every portal reports an outcome. Anything that reports a result is
 * therefore counted, including paths added later by someone who has never read ledger.js —
 * a guarantee that depends on remembering to add a line is not a guarantee.
 */
let ledger = null;
export function setLedger(l) { ledger = l; }

export function logSearch(keyword, location, count) {
  console.log('\n' + LINE);
  console.log(` 🔎  ${keyword}   ·   ${location}`);
  console.log(`     ${count} Easy-Apply job${count === 1 ? '' : 's'}`);
  console.log(LINE);
}

/**
 * The ledger the current block is writing to, or null.
 *
 * Exists so a block that DIES can still be accounted for. `seal()` is called at the end of the
 * adapter, and on 2026-08-14 the adapter threw when the browser closed — so the run produced no
 * ledger line at all. A run whose accounting is lost precisely when it went wrong is the one
 * case the ledger was built for, and it was the case it missed.
 */
export function currentLedger() { return ledger; }

export function logJobHeader(title, company, fitText) {
  const co = company ? `  ·  ${company}` : '';
  console.log(`\n  ▸ ${title}${co}${fitText ? `   (${fitText})` : ''}`);
}

export function logSkipped(title, reason) {
  record(ledger, 'skipped', reason);
  console.log(`\n  ⤼ ${title}   —   skipped: ${reason}`);
}

// Field rows are de-duplicated within a job so a multi-step form can't print the same
// question → answer five times. Call beginJob() as each job starts.
let seen = new Set();
export function beginJob() { seen = new Set(); }

export function logField(question, value) {
  const q = cleanQuestion(question);
  const key = q.toLowerCase() + '|' + String(value).toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  console.log(`       ${pad(q)} ${value}`);
}

/**
 * A question the automation could not answer.
 *
 * Recorded in BOTH places, and for both portals. The terminal line is truncated to stay
 * readable — `pad()` cuts a long question down to fit the column — so the one surface that
 * shows it is also the one that loses the wording you need in order to answer it. The log file
 * keeps the question in full, untruncated, alongside the portal and the reason.
 *
 * `reason` distinguishes the two ways this happens, which need different responses:
 *  · "no answer yet"  — nothing in the profile or saved answers covers it; answer it once
 *    in Automation → questions and it is reused from then on;
 *  · a guard refusal  — an answer existed but was unsafe to submit for THIS question
 *    (an annual rupee figure asked for as an hourly USD rate), which usually means the
 *    profile needs a separate field rather than a corrected one.
 */
export function logBlank(question, reason = 'no answer yet', portal = '') {
  const q = cleanQuestion(question);
  const key = 'blank|' + q.toLowerCase();
  // The log file is written EVERY time, before the de-duplication below. Seeing that the same
  // question blocked four different applications is the signal that it is worth answering, and
  // printing it once was hiding exactly that.
  logEvent('question', { portal: portal || undefined, unanswered: String(question), reason });
  if (seen.has(key)) return;
  seen.add(key);
  console.log(`       ${pad(q)} ⚠ ${reason} — saved to Autofill answers`);
}

const RESULTS = {
  applied:   '     ✅ Submitted',
  external:  '     ↗  External site — listed under Manual needed',
  attention: '     ⏸  Paused — needs your answer',
  none:      "     ✋ Manual needed — the Easy Apply form didn't open",
  failed:    '     ✗  Failed',
};
export function logResult(kind, extra) {
  record(ledger, kind, extra || kind);
  // For a pause, name the exact question that stopped it and where to answer it.
  if (kind === 'attention' && extra) {
    console.log(`     ⏸  Paused — needs your answer:  “${cleanQuestion(extra)}”`);
    console.log('        Answer it in  Automation → LinkedIn questions,  then it applies next time.');
    return;
  }
  console.log((RESULTS[kind] || `     → ${kind}`) + (extra ? `  (${extra})` : ''));
}

export function logSummary(portal, t) {
  console.log('\n' + DLINE);
  console.log(`  ${portal} block complete`);
  console.log(`    ✅ ${t.applied || 0} submitted      ⏸ ${t.attention || 0} need you      `
    + `✋ ${t.manual || 0} manual      ⤼ ${t.skipped || 0} skipped      ✗ ${t.failed || 0} failed`);
  console.log(DLINE + '\n');
}

// Question, padded to a fixed width with a dotted leader so answers line up in a column.
// Long questions are truncated in the MIDDLE — the distinguishing word is often at the end
// ("…experience with Go"), so lopping the tail would make every "how many years" row identical.
function pad(s) {
  const w = 58;
  if (s.length > w) {
    const keep = w - 1;
    const head = Math.ceil(keep * 0.62);
    s = s.slice(0, head).trimEnd() + '…' + s.slice(s.length - (keep - head)).trimStart();
  }
  return (s + ' ').padEnd(w + 1, '·');
}

/** Tidy a raw form label: drop "* / Required", and collapse LinkedIn's doubled question text. */
export function cleanQuestion(q) {
  let s = String(q || '').replace(/\s+/g, ' ').trim()
    .replace(/\s*required\s*$/i, '').replace(/\*+\s*$/, '').trim();
  const m = s.match(/^(.*?[?.:])\s*\1/); // "Are you…?Are you…?" -> "Are you…?"
  if (m) s = m[1].trim();
  // Exact doubling with no separator: "location (city)location (city)" -> "location (city)".
  const h = s.length / 2;
  if (Number.isInteger(h) && h > 4 && s.slice(0, h) === s.slice(h)) s = s.slice(0, h).trim();
  return s;
}
