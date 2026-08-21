/**
 * Polling that stops when nobody is looking.
 *
 * Supabase's free plan allows 5 GB of egress a month. This project used 11.6 GB, and the cause
 * was not the automation — the worker sends about 3 MB a day. It was this dashboard.
 *
 * Four panels pull the events table on a timer, and the heaviest asks for 2000 rows every six
 * seconds. At roughly 300 bytes a row that is ~600 KB per poll, or about 8 GB a day with the
 * page merely OPEN. Every one of those rows leaves Supabase and is counted.
 *
 * The worst part is that most of it was watched by nobody. `setInterval` does not care whether
 * the tab is in the background, minimised, or behind a screen lock — a dashboard left open in a
 * pinned tab overnight polls all night at full rate and transfers a database's worth of rows to
 * a page nobody can see.
 *
 * So: poll while the tab is visible, stop when it is hidden, and fetch once immediately on
 * return so the reader never sees stale numbers. Same code, same freshness where it matters,
 * a fraction of the bandwidth.
 */
export function startPoll(fn: () => void, everyMs: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const tick = () => { if (!stopped && !document.hidden) fn(); };

  const begin = () => {
    if (timer !== null || stopped) return;
    timer = setInterval(tick, everyMs);
  };
  const halt = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const onVisibility = () => {
    if (document.hidden) { halt(); return; }
    // Fetch straight away on return, THEN resume the timer. Waiting a full interval would show
    // the reader numbers from before they switched away, which is the one thing polling exists
    // to avoid.
    fn();
    begin();
  };

  if (!document.hidden) { fn(); begin(); }
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    stopped = true;
    halt();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
