import { useEffect, useRef } from 'react';
import { api } from '../api/client';
import { useToast } from './ui';

/**
 * Announce runs that start on their own.
 *
 * The automation now starts itself whenever JobPilot Desktop is open, so a run beginning is no
 * longer something you did — nothing on screen would tell you it had happened. This watches the
 * agent status app-wide and raises the same top-right success toast as every other action.
 *
 * Mounted once in Layout, so the toast reaches you on whatever page you're on.
 */
export function useRunStartToast() {
  const toast = useToast();
  // The run we last reported. Starts undefined, which means "we haven't looked yet" — the very
  // first poll only records what it finds, so refreshing mid-run doesn't re-announce it.
  const seen = useRef<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const LIVE = ['running', 'queued', 'needs_attention'];

    const poll = async () => {
      let run;
      try { run = (await api.agentStatus()).activeRun; } catch { return; }   // offline: try again later
      if (!alive) return;

      const id = run && LIVE.includes(run.status) ? run.id : '';
      const first = seen.current === undefined;
      const changed = seen.current !== id;
      seen.current = id;

      if (first || !changed || !id || !run) return;
      const name = run.portal === 'linkedin' ? 'LinkedIn' : run.portal === 'indeed' ? 'Indeed'
        : run.portal.charAt(0).toUpperCase() + run.portal.slice(1);
      toast(`${name} automation started — it's running now.`, 'success');
    };

    poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [toast]);
}
