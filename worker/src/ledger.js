// Run accountability: every job seen must leave with a recorded reason, and the numbers must
// reconcile before the run is allowed to call itself finished.
//
// fault.js covers failures we anticipated. This covers the case that actually cost the most
// time, which is the opposite: NOTHING failed and NOTHING happened. A run would see 80 jobs,
// apply to none, report "0 applied", and record no fault at all — because every job was merely
// "skipped". Each skip looked individually reasonable; the aggregate was a broken product, and
// there was no single line anywhere saying so.
//
// Every one of those runs turned out to have ONE dominant cause: a flat score of 43 for every
// job, a hidden threshold of 60 overriding the owner's 50, a dead browser returning empty
// searches, a truncated description that never reached the gate. In each case the reason was
// recorded per job and never counted. Counting them is the whole idea here.
//
// Three guarantees:
//
//   1. NOTHING UNACCOUNTED. Jobs seen must equal the outcomes recorded. A gap means the code
//      has a path that exits without saying why — that is reported as a fault in itself, and
//      it is precisely the kind of silent path that made previous runs unexplainable.
//   2. THE DOMINANT REASON IS NAMED. Not "0 applied" but "0 applied — 62 of 80 were: stack
//      mismatch (fit 43)". One line that points at the actual problem instead of inviting a
//      week of theories.
//   3. A RUN THAT ACHIEVES NOTHING SAYS SO. Zero applications from a non-empty search is not a
//      neutral outcome to be printed quietly; it is the headline.
import { logEvent } from './logfile.js';
import { fault } from './fault.js';

/** One run's outcomes. Created per block, sealed at the end. */
export function newLedger(portal) {
  return { portal, seen: 0, outcomes: new Map(), started: Date.now() };
}

/**
 * Record what happened to one job.
 *
 * `outcome` is the coarse bucket (applied / skipped / manual / attention / failed) and `reason`
 * is the specific cause. The reason is what gets counted — "skipped" tells nobody anything,
 * "stack mismatch (fit 43)" tells them everything.
 */
export function record(ledger, outcome, reason = '') {
  if (!ledger) return;
  ledger.seen++;
  // Strip the varying parts so reasons group. "fit 43" and "fit 57" are the same finding at
  // different scores, and keeping them apart would hide that 62 jobs shared one cause.
  const key = `${outcome}: ${String(reason || 'no reason given')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)}`;
  ledger.outcomes.set(key, (ledger.outcomes.get(key) || 0) + 1);
}

/**
 * Close the run and say what it actually did.
 *
 * Called whatever the ending — finished, stopped, timed out, crashed. A run that ends without
 * this is a run nobody can explain afterwards, which is the situation this exists to end.
 */
export function seal(ledger, { applied = 0, searched = 0 } = {}) {
  if (!ledger) return;
  const mins = Math.round((Date.now() - ledger.started) / 60000);
  const ranked = [...ledger.outcomes.entries()].sort((a, b) => b[1] - a[1]);

  logEvent('ledger', {
    portal: ledger.portal, minutes: mins, searched, applied,
    accountedFor: ledger.seen, outcomes: Object.fromEntries(ranked),
  });

  // GUARANTEE 1 — nothing unaccounted. A job the code saw but never recorded means a path that
  // exits silently, and a silent path is how a run becomes unexplainable after the fact.
  const gap = searched - ledger.seen;
  if (searched > 0 && gap > Math.max(2, searched * 0.05)) {
    fault('UNACCOUNTED_JOBS', {
      portal: ledger.portal, searched, accountedFor: ledger.seen, missing: gap,
    });
  }

  if (ledger.seen === 0) return;   // nothing was opened; the search-level faults cover that

  console.log(`\n  Why this run ended where it did — ${ledger.seen} job(s) accounted for:`);
  for (const [key, n] of ranked.slice(0, 6)) {
    const pct = Math.round((n / ledger.seen) * 100);
    console.log(`     ${String(n).padStart(4)}  (${String(pct).padStart(3)}%)  ${key}`);
  }

  // GUARANTEE 2 & 3 — a run that applied to nothing must name its dominant cause, loudly.
  // "0 applied" on its own is what started every long diagnostic detour in this project.
  if (applied === 0 && ranked.length) {
    const [topKey, topN] = ranked[0];
    const share = Math.round((topN / ledger.seen) * 100);
    fault('RUN_ACHIEVED_NOTHING', {
      portal: ledger.portal, minutes: mins, jobsSeen: ledger.seen,
      dominantCause: topKey, dominantCount: topN, dominantShare: `${share}%`,
      allOutcomes: Object.fromEntries(ranked),
    });
    console.log(`     -> ${share}% of this run ended the same way. If that is not what you`);
    console.log('        expect, THAT is the thing to fix — not the other outcomes.');
  }
}
