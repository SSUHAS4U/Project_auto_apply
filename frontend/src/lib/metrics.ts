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
export function countJobs(events: AgentEvent[], types: string[]): number {
  // "Posts analysed" is not one-event-per-post: the worker emits ONE event per keyword whose
  // detail reads "scanned N hiring post(s) for …". Counting those events showed 6 (the number
  // of keyword batches) when 150 posts had actually been read — so sum the N instead. The
  // worker writes a PER-KEYWORD count for exactly this reason.
  if (types.length === 1 && types[0] === 'post_analysed') {
    return events.reduce((sum, e) => {
      if (e.type !== 'post_analysed') return sum;
      const m = /scanned\s+(\d+)/i.exec(e.detail || '');
      return sum + (m ? Number(m[1]) : 1);
    }, 0);
  }
  const seen = new Set<string>();
  let n = 0;
  for (const e of events) {
    if (!types.includes(e.type)) continue;
    const k = jobKey(e);
    if (k && k !== '|') { if (seen.has(k)) continue; seen.add(k); }
    n++;
  }
  return n;
}
