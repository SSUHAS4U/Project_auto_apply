import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { desktop, isDesktopApp } from '../lib/desktop';
import { useToast } from '../lib/ui';
import { Icon } from './Icon';

/**
 * The automation terminal, embeddable — it runs the local worker and streams its live
 * output. Lives inside the floating hub's "Terminal" tab (desktop app only; in a plain
 * browser isDesktopApp() is false and the hub hides the tab). One click connects: we mint
 * the worker token from your session, so there's no code to paste.
 */
export function TerminalConsole() {
  const toast = useToast();
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
    return () => { offLog(); offStatus(); };
  }, [d]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  if (!isDesktopApp()) return null;

  const connect = async () => {
    setBusy(true);
    try {
      const { token } = await api.agentIssueToken();
      await d!.startWorker(token);
      toast('Connecting the automation worker…', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
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
          {running ? (
            <button className="btn btn-sm btn-danger-solid" onClick={disconnect} disabled={busy}>
              <Icon name="x" size={13} /> Disconnect
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={connect} disabled={busy}>
              <Icon name="play" size={13} /> Connect
            </button>
          )}
          <button className="btn btn-sm" onClick={() => setLog('')} title="Clear the log"><Icon name="trash" size={13} /></button>
        </div>
      </div>
      <pre ref={bodyRef} className="term-body" onScroll={onScroll} style={{ flex: 1, minHeight: 200, margin: 0 }}>
        {log || 'Click Connect to start the automation worker. A Chrome window opens the first time so you can sign into LinkedIn / Indeed once — after that it runs on schedule and streams here.'}
      </pre>
    </div>
  );
}
