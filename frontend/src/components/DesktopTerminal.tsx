import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { desktop, isDesktopApp } from '../lib/desktop';
import { useToast } from '../lib/ui';
import { Icon } from './Icon';

/**
 * The in-app terminal. Only exists inside the JobPilot desktop app (window.jobpilot); in a
 * plain browser it renders nothing. The button sits beside "Watch live"; clicking it opens a
 * bottom-docked console that runs the automation worker and streams its live output. One
 * click connects — we mint the worker token from your session, so there's no code to paste.
 */
export function DesktopTerminal() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const bodyRef = useRef<HTMLPreElement>(null);
  const stickToBottom = useRef(true);

  const d = desktop();

  // Subscribe to the worker's live output + status once (desktop only). The log is a single
  // capped buffer so line boundaries survive and long runs never grow unbounded.
  useEffect(() => {
    if (!d) return;
    d.getWorkerStatus().then((s) => setRunning(s.running)).catch(() => {});
    // Replay anything the worker already printed before this panel mounted (otherwise the
    // first lines are lost and it looks like nothing is streaming).
    d.getRecentLog?.().then((buf) => { if (buf) setLog((prev) => prev || buf.replace(/\r/g, '')); }).catch(() => {});
    const offLog = d.onWorkerLog((chunk) => {
      setLog((prev) => (prev + chunk.replace(/\r/g, '')).slice(-80000));
    });
    const offStatus = d.onWorkerStatus((s) => setRunning(s.running));
    return () => { offLog(); offStatus(); };
  }, [d]);

  // Auto-scroll to newest output unless the user has scrolled up to read history.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [log, open]);

  if (!isDesktopApp()) return null;

  const connect = async () => {
    setBusy(true);
    try {
      const { token } = await api.agentIssueToken();
      await d!.startWorker(token);
      setOpen(true);
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
    <>
      <button className={`btn ${open ? 'btn-primary' : ''}`} onClick={() => setOpen((o) => !o)}
        title="Automation terminal — run the worker and watch its live logs">
        <Icon name="terminal" size={15} /> Terminal
        <span className="live-dot" style={{ background: running ? '#34d399' : '#7d8595', marginLeft: 2 }} />
      </button>

      {open && (
        <div className="term-drawer">
          <div className="term-head">
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <Icon name="terminal" size={15} />
              <b style={{ fontSize: 13.5 }}>Automation terminal</b>
              <span className={`tone ${running ? 'tone-green' : 'tone-slate'}`} style={{ marginLeft: 4 }}>
                {running ? 'connected' : 'not connected'}
              </span>
            </div>
            <div className="row" style={{ gap: 8 }}>
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
              <button className="btn btn-sm" onClick={() => setOpen(false)} title="Hide"><Icon name="chevron" size={14} style={{ transform: 'rotate(90deg)' }} /></button>
            </div>
          </div>
          <pre ref={bodyRef} className="term-body" onScroll={onScroll}>
            {log || 'Click Connect to start the automation worker. A Chrome window opens the first time so you can sign into LinkedIn / Indeed once — after that it runs on schedule and streams here.'}
          </pre>
        </div>
      )}
    </>
  );
}
