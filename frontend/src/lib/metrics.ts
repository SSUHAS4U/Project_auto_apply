import type { AgentEvent } from '../types';

// One definition of "how we count", shared by the Dashboard cards, the Dashboard chart and the
// per-portal tiles — so every surface shows the SAME number for the same thing. The bug this
// fixes: the cards counted raw events (the same job appears in every city search, so 100 real
// jobs read as 710), while the chart deduped — so they disagreed and the whole thing looked
// broken.

export type Period = 'today' | 'week' | 'month' | 'total';

/** Start-of-window (ms) for a period. 0 = all time. */
export function sinceFor(period: Period): number {
  const d = new Date();
  if (period === 'today') { d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (period === 'week') { d.setDate(d.getDate() - 7); return d.getTime(); }
  if (period === 'month') { d.setDate(d.getDate() - 30); return d.getTime(); }
  return 0; // total
}

/** A job's identity: its URL, else title+company. Empty for non-job events (emails, replies…). */
export const jobKey = (e: AgentEvent) => (e.url || '').trim()
  || ((e.title || '') + '|' + (e.company || '')).toLowerCase().trim();

/**
 * Count events of the given types as DISTINCT JOBS. A job with an identity is counted once no
 * matter how many searches surfaced it; action events with no job identity (email_sent,
 * connection_sent, reply_received…) are counted individually, which is correct for them.
 */
export function countJobs(
  events: AgentEvent[],
  types: string[],
  opts: { skip?: (e: AgentEvent) => boolean } = {},
): number {
  // "Posts analysed" is not one-event-per-post. The worker emits TWO different post_analysed
  // events, and that is what made this number wrong:
  //
  //   per KEYWORD  detail "scanned N hiring post(s) for …"  — N is every post read
  //   per POST     detail "<author> — <topic> (85% sure)"   — one for a post that became a lead
  //
  // The per-post events are a SUBSET of what the keyword total already counted (linkedin.js
  // increments `analysedHere` for every post, then reports it in the keyword summary). Adding
  // 1 for each of them — which is what the old `: 1` fallback did — counted those posts twice
  // and inflated the headline figure. Only the keyword summaries carry a real count; anything
  // without one contributes NOTHING rather than an invented 1.
  if (types.length === 1 && types[0] === 'post_analysed') {
    return events.reduce((sum, e) => {
      if (e.type !== 'post_analysed') return sum;
      if (opts.skip?.(e)) return sum;
      const m = /scanned\s+(\d+)/i.exec(e.detail || '');
      return sum + (m ? Number(m[1]) : 0);
    }, 0);
  }
  const seen = new Set<string>();
  let n = 0;
  for (const e of events) {
    if (!types.includes(e.type)) continue;
    if (opts.skip?.(e)) continue;
    const k = jobKey(e);
    if (k && k !== '|') { if (seen.has(k)) continue; seen.add(k); }
    n++;
  }
  return n;
}
