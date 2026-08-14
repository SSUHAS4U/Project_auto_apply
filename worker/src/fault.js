// Fault capture: every failure records WHAT broke, WHERE, WHY, and WHAT TO DO about it.
//
// This exists because of how the last two weeks actually went. A failure would surface as one
// vague line — "the job page did not render", "answer failed", "the run was stopped" — and
// then a release would be spent guessing at the cause, shipping a fix for the wrong thing, and
// waiting for the next run to disprove it. Six versions were burned that way. Every single time
// the answer was already in the process; nothing had written it down.
//
// The rule this file enforces: a failure is not allowed to be reported as a symptom. It must
// carry the evidence that identifies it and the action that resolves it. If a fault cannot say
// what to do about it, that is itself the bug — it means we do not understand it yet, and the
// record says so explicitly rather than pretending.
import { logEvent } from './logfile.js';

/**
 * Known faults, keyed by a stable id.
 *
 * Each entry answers three questions that were asked repeatedly and could not be answered:
 *
 *   what   — what actually happened, in the owner's terms, not the code's
 *   why    — the mechanism, so a fix targets the cause and not the symptom
 *   action — what to DO. "Investigate" is not an action. Either the owner can act, or the
 *            automation recovers by itself, and the record says which.
 *
 * `owner: true` means a person must do something. `owner: false` means the automation handles
 * it and the entry exists so a recurring self-heal is visible rather than silent.
 */
export const FAULTS = {
  SESSION_EXPIRED: {
    what: 'The portal session is gone — the auth cookie is no longer in the browser profile.',
    why: 'Sessions expire, and a portal will also drop one it believes is automated.',
    action: 'Open Connections and press Connect. Sign in once in the window that appears.',
    owner: true,
  },
  BOT_CHALLENGE: {
    what: 'The portal served an anti-bot challenge instead of results.',
    why: 'Too many requests too quickly. LinkedIn labels the session uc=scraping via PerimeterX; '
       + 'Indeed answers with HTTP 429 and a Cloudflare Turnstile.',
    action: 'Nothing to fix by hand. The run stops and paces itself down. If it repeats every '
       + 'run, reduce keywords or locations in Setup — the matrix is larger than the site tolerates.',
    owner: false,
  },
  BROWSER_DEAD: {
    what: 'The automation browser stopped responding mid-run.',
    why: 'The browser process died. Every navigation then fails instantly, which reads as '
       + 'empty searches unless the failure is recorded.',
    action: 'The worker reopens it and retries the block. No action needed unless it repeats.',
    owner: false,
  },
  QUESTION_UNANSWERABLE: {
    what: 'A screening question has no answer in the profile or the answer bank.',
    why: 'A question never seen before, and not one the profile implies an answer to.',
    action: 'Answer it once in Automation → questions. Every later application reuses it.',
    owner: true,
  },
  ANSWER_UNSAFE: {
    what: 'An answer existed but was refused as wrong for the question asked.',
    why: 'The units or the kind did not match — an annual figure asked for per hour, a PIN code '
       + 'asked for as years. Submitting it would put a false statement in front of an employer.',
    action: 'Add the right value as a separate field in Profile, or answer this exact question '
       + 'in Automation → questions.',
    owner: true,
  },
  AI_UNAVAILABLE: {
    what: 'The AI provider refused, so a question that needed one went unanswered.',
    why: 'Free-tier quota, usually spent by the scheduled scout/discovery jobs before the run '
       + 'started rather than by the run itself.',
    action: 'Job matching no longer needs AI. If this blocks screening answers daily, add a '
       + 'second provider key in Settings → AI.',
    owner: true,
  },
  PORTAL_LAYOUT_CHANGED: {
    what: 'A page rendered, but the elements we read were not on it.',
    why: 'The portal changed its markup. Class names are hashed and change on deploy.',
    action: 'Needs a code change — this one cannot be fixed from the dashboard. The record '
       + 'below carries the URL and what WAS on the page, which is what a fix needs.',
    owner: false,
  },
  PANE_WRONG_JOB: {
    what: 'The job pane showed a different job than the one requested, so it was skipped.',
    why: 'LinkedIn ignores currentJobId when it is under load and keeps whatever job was '
       + 'already open. Judging that text would file a verdict against the wrong posting.',
    action: 'Nothing to do — the job is skipped rather than mis-judged, and the next run sees '
       + 'it again. Repeating on every job means pacing is too fast; reduce the search matrix.',
    owner: false,
  },
  PANE_NOT_RENDERING: {
    what: 'Job pages are loading but the content we read is not on them.',
    why: 'Either the portal is withholding data (a soft block) or it changed its markup. The '
       + 'log records the URL actually landed on, which tells the two apart.',
    action: 'If the log shows a challenge or a 429, it is pacing and the run backs off by '
       + 'itself. If the page looks normal, the markup changed and it needs a code fix.',
    owner: false,
  },
  APPLY_FORM_UNRECOGNISED: {
    what: 'The apply form opened but had no Submit or Continue control we recognise.',
    why: 'The portal renamed or restructured the button, or an interstitial appeared in front '
       + 'of the form.',
    action: 'Needs a code fix. The log lists every button that WAS on the form, which is what '
       + 'a fix needs — no reproduction required.',
    owner: false,
  },
  NO_APPLY_BUTTON: {
    what: 'Every job in the search redirected to an employer site instead of applying here.',
    why: 'Normal on Indeed for some searches — many listings are external. All of them being '
       + 'external usually means the button selector went stale instead.',
    action: 'Open Applications -> Manual needed and try one. If it really is an employer site, '
       + 'nothing is wrong. If it shows an Apply button, the selector went stale and it needs a '
       + 'code fix.',
    owner: true,
  },
  MESSAGE_NOT_SENT: {
    what: 'A message was composed but not sent, because the text did not reach the box.',
    why: 'A click that missed, lost focus, or an attachment that re-rendered the form and '
       + 'cleared it. Sending anyway would put a bare resume in front of a recruiter.',
    action: 'Nothing to do — the person is left for the next run rather than messaged badly.',
    owner: false,
  },
  INVITE_LIMIT: {
    what: 'LinkedIn has stopped accepting new invitations from this account.',
    why: 'The weekly allowance is spent, and pending invitations count against it.',
    action: 'Withdraw old invitations at linkedin.com/mynetwork/invitation-manager/sent/. '
       + 'Direct messages are unaffected and are tried first.',
    owner: true,
  },
  PROFILE_NO_CONTROLS: {
    what: 'A profile opened with no Connect and no Message control.',
    why: 'Their privacy settings, or the page did not finish rendering.',
    action: 'Nothing to do — that person is skipped and the run continues.',
    owner: false,
  },
  UNACCOUNTED_JOBS: {
    what: 'The run opened jobs it never recorded an outcome for.',
    why: 'A code path exits without saying what it decided. Those jobs are invisible in every '
       + 'summary, which is how a run becomes impossible to explain after the fact.',
    action: 'Needs a code fix — the counts below say how many went missing, and the ledger in '
       + 'the log lists every outcome that WAS recorded, so the gap is findable.',
    owner: false,
  },
  RUN_ACHIEVED_NOTHING: {
    what: 'The run finished without applying to anything.',
    why: 'Not a failure in itself — but it always has ONE dominant cause, and that cause is '
       + 'named below rather than left to be guessed at across several releases.',
    action: 'Read the dominant cause below. If it is a fit score, adjust fitMin or your skills '
       + 'in Setup. If it is a block or a challenge, the pacing handles it. If it is anything '
       + 'else, that single line is what needs fixing — not the other outcomes.',
    owner: true,
  },
  CODE_FAULT: {
    what: 'The automation itself threw an error.',
    why: 'A bug in JobPilot, not in the portal or the account.',
    action: 'Needs a code change. The stack below identifies the line — no reproduction needed.',
    owner: false,
  },
};

/**
 * Record a fault.
 *
 * Writes the full record to the log file and prints the useful part to the terminal. The
 * terminal gets what a person can act on; the file gets everything, because the evidence that
 * turns out to matter is never the evidence you expected to need.
 *
 * @param {string} id       a key of FAULTS
 * @param {object} evidence anything that identifies THIS occurrence — url, job, error, counts
 */
export function fault(id, evidence = {}) {
  const known = FAULTS[id];
  if (!known) {
    // An unregistered id is itself a fault: it means a failure path was added without deciding
    // what the owner should do about it, which is the habit this module exists to break.
    logEvent('fault', { id: 'UNREGISTERED_FAULT', requested: id, evidence });
    console.log(`     ⚠ ${id} (no guidance registered for this fault — that is a bug)`);
    return;
  }
  logEvent('fault', { id, ...known, evidence });
  console.log(`     ⚠ ${known.what}`);
  console.log(`        why:  ${known.why}`);
  console.log(`        do:   ${known.action}`);
}

/**
 * Wrap an unexpected exception as a CODE_FAULT.
 *
 * Anything that reaches here is ours — a portal being difficult produces a specific fault
 * above, so a bare exception means JobPilot broke. The stack is kept in full in the log: the
 * `title is not defined` bug that failed 38 applications was diagnosable from one stack frame,
 * and instead cost a release because nothing recorded it.
 */
export function codeFault(err, where = '') {
  fault('CODE_FAULT', {
    where,
    message: String(err && err.message ? err.message : err).slice(0, 300),
    stack: String(err && err.stack ? err.stack : '').split('\n').slice(0, 6).join(' | '),
  });
}
