import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AgentEvent, AgentFrame, AgentSchedule, AgentStatus } from '../types';
import { fmtDate, useToast } from '../lib/ui';
import { Icon } from './Icon';
import { Modal } from './Modal';

/**
 * Shared automation panels for the unified Engine page: a Watch-Live popup, per-portal
 * metrics (LinkedIn / Indeed shown separately), the activity feed and the schedule editor.
 * There is ONE automation (the daily scheduled worker); these are just its views.
 */

const EVENT_ICON: Record<string, { name: string; color: string }> = {
  post_analysed: { name: 'search', color: '#60a5fa' },
  job_identified: { name: 'target', color: '#818cf8' },
  relevant: { name: 'sparkles', color: '#fbbf24' },
  applied: { name: 'send', color: '#34d399' },
  easy_apply: { name: 'bolt', color: '#818cf8' },
  manual_apply: { name: 'alert', color: '#fbbf24' },
  connection_sent: { name: 'link', color: '#60a5fa' },
  message_sent: { name: 'send', color: '#a78bfa' },
  email_sent: { name: 'mail', color: '#34d399' },
  reply_received: { name: 'mail', color: '#2dd4bf' },
  error: { name: 'alert', color: '#f87171' },
  info: { name: 'circle', color: '#7d8595' },
};

// ---- Run controls + Watch live (the header actions) -------------------------

/**
 * Start the automation NOW (or pause/stop a live run) + Watch live. The scheduled blocks
 * run automatically, but this lets you kick off a run immediately once JobPilot Desktop is
 * connected — which is what you need when it says "waiting for a run".
 */
export function RunControls() {
  const toast = useToast();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.agentStatus().then(setStatus).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);

  const online = status?.workerOnline ?? false;
  const run = status?.activeRun ?? null;
  const live = !!run && ['running', 'queued', 'needs_attention'].includes(run.status);

  const start = async (portal: string) => {
    setBusy(true);
    try { await api.agentStartRun(portal); toast(`${portal} run queued — JobPilot Desktop will start it within seconds.`, 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const stop = async () => {
    if (!run) return;
    setBusy(true);
    try { await api.agentStopRun(run.id); toast('Run stopped.', 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const pause = async () => {
    setBusy(true);
    try { await api.agentPause(!status?.paused); load(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className={`tone ${live ? 'tone-green live-pulse' : online ? 'tone-blue' : 'tone-slate'}`} style={{ padding: '5px 11px' }}>
        <span className="live-dot" /> {live ? `running · ${run?.portal}` : online ? 'desktop ready' : 'desktop offline'}
      </span>
      {live ? (
        <>
          <button className="btn btn-sm" onClick={pause} disabled={busy}>
            <Icon name={status?.paused ? 'play' : 'pause'} size={13} /> {status?.paused ? 'Resume' : 'Pause'}
          </button>
          <button className="btn btn-sm btn-danger-solid" onClick={stop} disabled={busy}><Icon name="x" size={13} /> Stop</button>
        </>
      ) : (
        <>
          <button className="btn btn-primary btn-sm" onClick={() => start('linkedin')} disabled={busy || !online}
            title={online ? 'Run a LinkedIn block now' : 'Open JobPilot Desktop first (Connections)'}>
            <Icon name="play" size={13} /> Run LinkedIn
          </button>
          <button className="btn btn-sm" onClick={() => start('indeed')} disabled={busy || !online}
            title={online ? 'Run an Indeed block now' : 'Open JobPilot Desktop first (Connections)'}>
            <Icon name="play" size={13} /> Run Indeed
          </button>
        </>
      )}
      <WatchLiveButton />
    </div>
  );
}

export function WatchLiveButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn btn-primary" onClick={() => setOpen(true)}>
        <Icon name="live" size={15} /> Watch live
      </button>
      {open && <LiveModal onClose={() => setOpen(false)} />}
    </>
  );
}

function LiveModal({ onClose }: { onClose: () => void }) {
  const [frame, setFrame] = useState<AgentFrame | null>(null);
  useEffect(() => {
    let stop = false;
    const pull = async () => { try { const f = await api.agentFrame(); if (!stop) setFrame(f); } catch { /* keep last */ } };
    pull();
    const t = setInterval(pull, 1500);
    return () => { stop = true; clearInterval(t); };
  }, []);
  return (
    <Modal title="Watch live — what the automation is doing" onClose={onClose} wide>
      <div className="row" style={{ gap: 10, marginBottom: 10, alignItems: 'center' }}>
        <span className={`tone ${frame?.hasFrame ? 'tone-green live-pulse' : 'tone-slate'}`} style={{ padding: '5px 12px' }}>
          <span className="live-dot" /> {frame?.action || 'Idle — waiting for a run'}
        </span>
        <span className="faint" style={{ fontSize: 12 }}>
          {frame?.portal ? `${frame.portal} · ` : ''}{frame?.updatedAt ? fmtDate(frame.updatedAt) : 'no feed yet'}
        </span>
      </div>
      <div style={{ background: '#000', borderRadius: 12, minHeight: 320, display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
        {frame?.hasFrame ? (
          <img src={`data:image/jpeg;base64,${frame.imageB64}`} alt="live"
            style={{ width: '100%', maxHeight: '64vh', objectFit: 'contain' }} />
        ) : (
          <div className="faint" style={{ padding: 48, textAlign: 'center' }}>
            <div style={{ opacity: .5, marginBottom: 10 }}><Icon name="live" size={44} /></div>
            Waiting for JobPilot Desktop's screen feed.<br />Start the app and queue a run — the automation streams here.
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---- Per-portal metrics (LinkedIn vs Indeed) --------------------------------

export function PortalMetrics({ kind }: { kind?: 'all' | 'applied' }) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  useEffect(() => {
    const pull = () => api.agentEvents(400).then(setEvents).catch(() => {});
    pull();
    const t = setInterval(pull, 8000);
    return () => clearInterval(t);
  }, []);

  const block = (portal: 'linkedin' | 'indeed') => {
    const ev = events.filter((e) => e.portal === portal);
    const n = (t: string) => ev.filter((e) => e.type === t).length;
    const applied = n('applied') + n('easy_apply');
    const manual = ev.filter((e) => e.type === 'manual_apply');
    const cells: [string, number, string][] = portal === 'linkedin'
      ? [['Jobs found', n('job_identified'), 'indigo'], ['Relevant', n('relevant'), 'amber'],
         ['Applied (Easy Apply)', applied, 'green'], ['Emails sent', n('email_sent'), 'green'],
         ['Connections sent', n('connection_sent'), 'blue'], ['Replies', n('reply_received'), 'purple'],
         ['Manual needed', manual.length, 'amber'], ['Failed', n('error'), 'red']]
      : [['Jobs found', n('job_identified'), 'indigo'], ['Relevant', n('relevant'), 'amber'],
         ['Applied', applied, 'green'], ['Manual needed', manual.length, 'amber'], ['Failed', n('error'), 'red']];
    return (
      <div className="card card-pad" key={portal}>
        <div className="card-title">
          <Icon name={portal === 'linkedin' ? 'link' : 'target'} size={15} />
          {portal === 'linkedin' ? 'LinkedIn' : 'Indeed'}
        </div>
        <div className="metric-row">
          {cells.map(([label, v, tone]) => (
            <div key={label} className="metric-cell">
              <span className={`tone tone-${tone}`} style={{ fontSize: 16, fontWeight: 750, padding: '5px 13px' }}>{v}</span>
              <span className="faint" style={{ fontSize: 11.5, textAlign: 'center' }}>{label}</span>
            </div>
          ))}
        </div>
        {kind !== 'applied' && manual.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="kv-k" style={{ marginBottom: 8 }}>Apply manually — automation couldn't ({manual.length})</div>
            {manual.slice(0, 6).map((e) => (
              <div key={e.id} className="row" style={{ gap: 8, padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
                <Icon name="alert" size={13} className="t-amber" style={{ flex: 'none' }} />
                <a href={e.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>
                  {e.title || 'Job'}{e.company ? ` — ${e.company}` : ''}
                </a>
                <span className="faint" style={{ fontSize: 11.5, flex: 'none' }}>{fmtDate(e.createdAt)}</span>
              </div>
            ))}
            <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>Also emailed to you each evening (21:45 IST).</div>
          </div>
        )}
      </div>
    );
  };

  return <div style={{ display: 'grid', gap: 14 }}>{block('linkedin')}{block('indeed')}</div>;
}

// ---- Activity feed ----------------------------------------------------------

export function ActivityFeed() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  useEffect(() => {
    const pull = () => api.agentEvents(80).then(setEvents).catch(() => {});
    pull();
    const t = setInterval(pull, 4000);
    return () => clearInterval(t);
  }, []);

  if (events.length === 0) {
    return <div className="card card-pad empty"><div className="big"><Icon name="clipboard" size={34} /></div>No activity yet — it fills as the automation runs.</div>;
  }
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {events.map((e) => {
        const ei = EVENT_ICON[e.type] ?? EVENT_ICON.info;
        return (
          <div key={e.id} className="row card-pad" style={{ gap: 10, alignItems: 'flex-start', borderBottom: '1px solid var(--border)' }}>
            <span className="ev-ico" style={{ color: ei.color, background: ei.color + '1f' }}><Icon name={ei.name} size={15} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13 }}>
                {e.title ? <a href={e.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>{e.title}</a> : <b>{e.type.replace('_', ' ')}</b>}
                {e.company && <span className="faint"> · {e.company}</span>}
                {e.portal && <span className={`tone tone-${e.portal === 'linkedin' ? 'blue' : 'indigo'}`} style={{ marginLeft: 8 }}>{e.portal}</span>}
              </div>
              {e.detail && <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{e.detail}</div>}
            </div>
            <span className="faint" style={{ fontSize: 11.5, flex: 'none' }}>{fmtDate(e.createdAt)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---- Schedule editor --------------------------------------------------------

export function ScheduleEditor() {
  const toast = useToast();
  const [blocks, setBlocks] = useState<AgentSchedule[]>([]);
  useEffect(() => { api.agentSchedule().then(setBlocks).catch(() => {}); }, []);

  const upd = (i: number, patch: Partial<AgentSchedule>) =>
    setBlocks((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const save = async () => {
    try { setBlocks(await api.agentSaveSchedule(blocks)); toast('Schedule saved', 'success'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const usePreset = async () => {
    if (!window.confirm('Replace your schedule with the recommended plan? (Easy Apply 2×/day per portal + one long evening outreach slot)')) return;
    try { setBlocks(await api.agentSchedulePreset()); toast('Recommended plan applied', 'success'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div className="card card-pad">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h3 style={{ margin: 0 }}>Daily schedule</h3>
          <p className="faint" style={{ fontSize: 13, margin: '4px 0 12px', maxWidth: 620, lineHeight: 1.6 }}>
            The automation runs these blocks each day. <b>Apply</b> blocks do Easy Apply only;
            the <b>Outreach</b> block scans posts, harvests HR emails and sends connections — give it the most time.
            Blank keywords/locations = derived from your Job profile.
          </p>
        </div>
        <button className="btn btn-sm" onClick={usePreset}><Icon name="sparkles" size={13} /> Use recommended plan</button>
      </div>
      {blocks.length === 0 && <div className="faint" style={{ fontSize: 13 }}>No schedule yet — click “Use recommended plan”.</div>}
      {blocks.map((b, i) => (
        <div key={i} className="card card-pad" style={{ marginBottom: 8, background: 'var(--bg-elev)' }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <b style={{ textTransform: 'capitalize', minWidth: 72 }}>{b.portal}</b>
            <label style={{ fontSize: 12 }}>Mode
              <select className="select" style={{ width: 110 }} value={b.mode ?? 'apply'} onChange={(e) => upd(i, { mode: e.target.value })}>
                <option value="apply">Apply</option>
                <option value="outreach">Outreach</option>
              </select></label>
            <label style={{ fontSize: 12 }}>Start
              <input className="input" style={{ width: 90 }} value={b.startTime ?? ''} placeholder="09:00" onChange={(e) => upd(i, { startTime: e.target.value })} /></label>
            <label style={{ fontSize: 12 }}>Mins
              <input className="input" type="number" style={{ width: 80 }} value={b.durationMins} onChange={(e) => upd(i, { durationMins: +e.target.value })} /></label>
            <label style={{ fontSize: 12 }}>Apply cap
              <input className="input" type="number" style={{ width: 80 }} value={b.applyCap} onChange={(e) => upd(i, { applyCap: +e.target.value })} /></label>
            <label className="row" style={{ fontSize: 12, gap: 4, alignItems: 'center' }}>
              <input type="checkbox" checked={b.enabled} onChange={(e) => upd(i, { enabled: e.target.checked })} /> on</label>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="keywords (comma-sep, blank = from profile)"
              value={b.keywords ?? ''} onChange={(e) => upd(i, { keywords: e.target.value })} />
            <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="locations (comma-sep)"
              value={b.locations ?? ''} onChange={(e) => upd(i, { locations: e.target.value })} />
          </div>
        </div>
      ))}
      {blocks.length > 0 && <button className="btn btn-primary btn-sm" onClick={save} style={{ marginTop: 8 }}>Save schedule</button>}
    </div>
  );
}
