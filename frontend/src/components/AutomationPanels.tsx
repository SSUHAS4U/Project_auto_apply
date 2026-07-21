import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { api } from '../api/client';
import type { AgentEvent, AgentFrame, AgentSchedule, AgentStatus } from '../types';
import { fmtDate, useToast } from '../lib/ui';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { DesktopTerminal } from './DesktopTerminal';

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

// Semantic tone → CSS var, for the stat tiles (a real value lights up in its tone; zero stays muted).
const TONE_COLOR: Record<string, string> = {
  green: 'var(--green)', amber: 'var(--amber)', red: 'var(--red)',
  blue: 'var(--blue)', purple: 'var(--purple)', indigo: 'var(--accent-hi)', slate: 'var(--text-dim)',
};
const mtileStyle = (color: string): CSSProperties => ({ ['--mtile-c']: color } as CSSProperties);

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
      <DesktopTerminal />
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

  // TODAY only — otherwise stale errors from earlier days (e.g. the old captcha loop) pile
  // up here and read as "161 failed" even when nothing ran today.
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const todays = events.filter((e) => e.createdAt && new Date(e.createdAt) >= startOfToday);

  const block = (portal: 'linkedin' | 'indeed') => {
    const ev = todays.filter((e) => e.portal === portal);
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
        <div className="mtile-grid">
          {cells.map(([label, v, tone]) => (
            <div key={label} className="mtile" style={mtileStyle(v ? TONE_COLOR[tone] : 'var(--text-faint)')}>
              <span className="mtile-num">{v}</span>
              <span className="mtile-label">{label}</span>
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

  const PORTAL: Record<string, { color: string; letter: string; parked?: boolean }> = {
    linkedin: { color: '#0A66C2', letter: 'in' },
    indeed: { color: '#2557A7', letter: 'i' },
    naukri: { color: '#6D28D9', letter: 'n', parked: true },
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="card card-pad" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <Icon name="clock" size={16} style={{ color: 'var(--accent-hi)', flex: 'none', transform: 'translateY(1px)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>Runs automatically, every day</div>
          <div className="faint" style={{ fontSize: 12.5, marginTop: 2, lineHeight: 1.6 }}>
            When JobPilot Desktop is connected, each block below starts on its own at its time.
            <b> Apply</b> = Easy Apply only · <b>Outreach</b> = scan posts, harvest HR emails, send connections
            (give it the most time). Blank keywords/locations come from your Job profile.
          </div>
        </div>
        <button className="btn btn-sm" onClick={usePreset} style={{ flex: 'none' }}><Icon name="sparkles" size={13} /> Recommended plan</button>
      </div>

      {blocks.length === 0 && (
        <div className="card card-pad empty"><div className="big"><Icon name="clock" size={32} /></div>No schedule yet — click “Recommended plan” to set the daily runs.</div>
      )}

      {blocks.map((b, i) => {
        const meta = PORTAL[b.portal] ?? { color: 'var(--accent)', letter: b.portal[0] };
        return (
          <div key={i} className={`card sched-card ${b.enabled && !meta.parked ? '' : 'off'}`}>
            <div className="sched-head">
              <div className="conn-logo" style={{ width: 40, height: 40, borderRadius: 11, fontSize: 15, background: meta.color }}>{meta.letter}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="conn-name" style={{ textTransform: 'capitalize' }}>{b.portal}
                  {meta.parked && <span className="tone tone-amber" style={{ marginLeft: 8 }}>in progress</span>}</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {b.mode === 'outreach' ? 'Outreach — posts, HR emails, connections' : 'Easy Apply'} · {b.startTime || '—'} for {b.durationMins}m
                </div>
              </div>
              <button role="switch" aria-checked={b.enabled} aria-label={`${b.portal} enabled`}
                className={`switch ${b.enabled ? 'on' : ''}`} onClick={() => upd(i, { enabled: !b.enabled })} disabled={meta.parked}>
                <span className="knob" />
              </button>
            </div>

            <div className="sched-grid">
              <label className="field">Mode
                <select className="select" value={b.mode ?? 'apply'} onChange={(e) => upd(i, { mode: e.target.value })} disabled={meta.parked}>
                  <option value="apply">Apply</option><option value="outreach">Outreach</option>
                </select>
              </label>
              <label className="field">Start time
                <input className="input" value={b.startTime ?? ''} placeholder="09:00" onChange={(e) => upd(i, { startTime: e.target.value })} disabled={meta.parked} />
              </label>
              <label className="field">Duration (min)
                <input className="input" type="number" value={b.durationMins} onChange={(e) => upd(i, { durationMins: +e.target.value })} disabled={meta.parked} />
              </label>
              <label className="field">Apply cap
                <input className="input" type="number" value={b.applyCap} onChange={(e) => upd(i, { applyCap: +e.target.value })} disabled={meta.parked} />
              </label>
            </div>
            <div className="grid2" style={{ marginTop: 10 }}>
              <label className="field">Keywords <span className="faint">— blank = from profile</span>
                <input className="input" value={b.keywords ?? ''} onChange={(e) => upd(i, { keywords: e.target.value })} disabled={meta.parked} />
              </label>
              <label className="field">Locations
                <input className="input" value={b.locations ?? ''} onChange={(e) => upd(i, { locations: e.target.value })} disabled={meta.parked} />
              </label>
            </div>
          </div>
        );
      })}
      {blocks.length > 0 && <div><button className="btn btn-primary" onClick={save}><Icon name="check" size={14} /> Save schedule</button></div>}
    </div>
  );
}
