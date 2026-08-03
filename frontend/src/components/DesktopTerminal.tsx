import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { desktop, isDesktopApp } from '../lib/desktop';
import { Icon } from './Icon';

/**
 * The automation terminal, embeddable — it runs the local worker and streams its live
 * output. Lives inside the floating hub's "Terminal" tab (desktop app only; in a plain
 * browser isDesktopApp() is false and the hub hides the tab). It STARTS ITSELF when the app
 * opens — there is no Connect button here; portals are connected once on the Connections page.
 */
export function TerminalConsole() {
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

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [log]);

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
        {log || 'Starting the automation…\n\nIf this is your first run, connect LinkedIn / Indeed once on the Connections page. After that it starts automatically every time you open the app.'}
      </pre>
    </div>
  );
}
