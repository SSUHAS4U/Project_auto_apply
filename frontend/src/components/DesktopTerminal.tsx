import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { desktop, isDesktopApp } from '../lib/desktop';
import { filterPortalLog, hasPortalActivity, type PortalKey } from '../lib/portalLog';
import { Icon } from './Icon';

/**
 * The automation terminal, embeddable — it runs the local worker and streams its live
 * output. Lives inside the floating hub's "Terminal" tab (desktop app only; in a plain
 * browser isDesktopApp() is false and the hub hides the tab). It STARTS ITSELF when the app
 * opens — there is no Connect button here; portals are connected once on the Connections page.
 *
 * @param portal when set, show ONLY that portal's blocks (plus the shared startup output).
 *        The LinkedIn page must not show Indeed's run and vice versa: one stream on two pages
 *        meant reading past a hundred lines of the other portal to find your own.
 */
export function TerminalConsole({ portal }: { portal?: PortalKey } = {}) {
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const bodyRef = useRef<HTMLPreElement>(null);
  const stickToBottom = useRef(true);

  const d = desktop();

  useEffect(() => {
    if (!d) return;
    d.getWorkerStatus().then((s) => setRunning(s.running)).catch(() => {});
    // Replay anything the worker already printed before this mounted (otherwise the first
    // lines are lost and it looks like nothing is streaming).
    d.getRecentLog?.().then((buf) => { if (buf) setLog((prev) => prev || buf.replace(/\r/g, '')); }).catch(() => {});
    const offLog = d.onWorkerLog((chunk) => setLog((prev) => (prev + chunk.replace(/\r/g, '')).slice(-80000)));
    const offStatus = d.onWorkerStatus((s) => setRunning(s.running));
    // If it isn't already running a moment after mount, start it — no click required.
    const t = setTimeout(() => { d.getWorkerStatus().then((s) => { if (!s.running) autoStart(); }).catch(() => {}); }, 1500);
    return () => { clearTimeout(t); offLog(); offStatus(); };
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  // What this terminal actually shows. Filtering happens at render, not at capture, so the
  // underlying buffer stays whole — switching pages never loses lines that were already
  // streamed, and the unfiltered hub terminal keeps working from the same buffer.
  const shown = useMemo(() => (portal ? filterPortalLog(log, portal) : log), [log, portal]);
  const sawPortal = useMemo(() => (portal ? hasPortalActivity(log, portal) : true), [log, portal]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  if (!isDesktopApp()) return null;

  // Belt-and-braces auto-start: the Electron shell already starts the worker when the app
  // opens, but if it hasn't (first mount after a manual Stop, or a token minted just now),
  // start it here too. Silent — no button, no toast; the log shows what's happening.
  const autoStart = async () => {
    if (running || busy) return;
    setBusy(true);
    try {
      const { token } = await api.agentIssueToken();
      await d!.startWorker(token);
    } catch { /* the log surfaces the reason */ }
    finally { setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true);
    try { await d!.stopWorker(); } catch { /* ignore */ } finally { setBusy(false); }
  };
  const onScroll = () => {
    const el = bodyRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="row" style={{ gap: 8, marginBottom: 10, alignItems: 'center' }}>
        <span className={`tone ${running ? 'tone-green live-pulse' : 'tone-slate'}`}>
          {running && <span className="live-dot" />}{running ? 'connected' : 'not connected'}
        </span>
        <div style={{ marginLeft: 'auto' }} className="row">
          {/* No Connect button here: the automation starts itself when the app opens. This is a
              LOG, not a control panel. Stop is kept for when you want to halt it deliberately;
              connecting a portal for the first time happens on the Connections page. */}
          {running ? (
            <button className="btn btn-sm btn-danger-solid" onClick={disconnect} disabled={busy}>
              <Icon name="x" size={13} /> Stop
            </button>
          ) : (
            <span className="faint" style={{ fontSize: 12.5 }}>starts automatically…</span>
          )}
          <button className="btn btn-sm" title="Clear the log"
            onClick={() => { setLog(''); d?.clearLog?.().catch(() => {}); }}>
            <Icon name="trash" size={13} /></button>
        </div>
      </div>
      <pre ref={bodyRef} className="term-body" onScroll={onScroll} style={{ flex: 1, minHeight: 200, margin: 0 }}>
        {shown || (portal && !sawPortal
          ? `Waiting for the ${portal === 'linkedin' ? 'LinkedIn' : 'Indeed'} block to start.\n\n`
            + 'The two portals run one after the other, never at the same time — this view shows '
            + `only ${portal === 'linkedin' ? 'LinkedIn' : 'Indeed'}, so it stays empty while the other one is working.`
          : 'Starting the automation…\n\nIf this is your first run, connect LinkedIn / Indeed once on the Connections page. After that it starts automatically every time you open the app.')}
      </pre>
    </div>
  );
}
