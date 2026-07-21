import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { api } from '../api/client';
import type { AgentEvent, AgentFrame, AgentSchedule, AgentStatus } from '../types';
import { fmtDate, useToast } from '../lib/ui';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { TerminalConsole } from './DesktopTerminal';
import { isDesktopApp } from '../lib/desktop';

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
      {/* Watch live + Terminal stay right here in the Auto Apply header (they're ALSO in the
          floating hub for every other page). */}
      <WatchLiveButton />
      <TerminalButton />
    </div>
  );
}

/** "Watch live" button for the Auto Apply header — opens the live feed in a modal. */
export function WatchLiveButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        <Icon name="live" size={14} /> Watch live
      </button>
      {open && (
        <Modal title="Watch live — what the automation is doing" onClose={() => setOpen(false)} wide>
          <div style={{ height: '62vh' }}><LiveView /></div>
        </Modal>
      )}
    </>
  );
}

/** "Terminal" button for the Auto Apply header (desktop app only) — opens the console. */
function TerminalButton() {
  const [open, setOpen] = useState(false);
  if (!isDesktopApp()) return null;
  return (
    <>
      <button className="btn btn-sm" onClick={() => setOpen(true)}>
        <Icon name="terminal" size={14} /> Terminal
      </button>
      {open && (
        <Modal title="Automation terminal" onClose={() => setOpen(false)} wide>
          <div style={{ height: '62vh' }}><TerminalConsole /></div>
        </Modal>
      )}
    </>
  );
}

/**
 * Live screen feed — the polling status pill + the streamed frame. Extracted so it can live
 * inside the floating hub (Watch-live tab) instead of a separate modal/button.
 */
export function LiveView() {
  const [frame, setFrame] = useState<AgentFrame | null>(null);
  useEffect(() => {
    let stop = false;
    const pull = async () => { try { const f = await api.agentFrame(); if (!stop) setFrame(f); } catch { /* keep last */ } };
    pull();
    const t = setInterval(pull, 1500);
    return () => { stop = true; clearInterval(t); };
  }, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="row" style={{ gap: 10, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={`tone ${frame?.hasFrame ? 'tone-green live-pulse' : 'tone-slate'}`} style={{ padding: '5px 12px' }}>
          <span className="live-dot" /> {frame?.action || 'Idle — waiting for a run'}
        </span>
        <span className="faint" style={{ fontSize: 12 }}>
          {frame?.portal ? `${frame.portal} · ` : ''}{frame?.updatedAt ? fmtDate(frame.updatedAt) : 'no feed yet'}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 240, background: '#000', borderRadius: 12, display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
        {frame?.hasFrame ? (
          <img src={`data:image/jpeg;base64,${frame.imageB64}`} alt="live"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <div className="faint" style={{ padding: 40, textAlign: 'center' }}>
            <div style={{ opacity: .5, marginBottom: 10 }}><Icon name="live" size={40} /></div>
            Waiting for JobPilot Desktop's screen feed.<br />Start the app and queue a run — the automation streams here.
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Per-portal metrics (LinkedIn vs Indeed) --------------------------------

export function PortalMetrics() {
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

  const [sel, setSel] = useState<{ portal: string; label: string } | null>(null);
  const [done, setDone] = useState<Set<string>>(() => loadDone());
  const dismiss = (key: string) => setDone((prev) => {
    const next = new Set(prev); next.add(key);
    try { localStorage.setItem(doneKey(), JSON.stringify([...next])); } catch { /* ignore */ }
    return next;
  });

  const block = (portal: 'linkedin' | 'indeed') => {
    const ev = todays.filter((e) => e.portal === portal);
    const list = (types: string[]) => ev.filter((e) => types.includes(e.type));
    type Cell = { label: string; tone: string; types: string[] };
    const cells: Cell[] = portal === 'linkedin'
      ? [{ label: 'Jobs found', tone: 'indigo', types: ['job_identified'] },
         { label: 'Relevant', tone: 'amber', types: ['relevant'] },
         { label: 'Applied (Easy Apply)', tone: 'green', types: ['applied', 'easy_apply'] },
         { label: 'Emails sent', tone: 'green', types: ['email_sent'] },
         { label: 'Connections sent', tone: 'blue', types: ['connection_sent'] },
         { label: 'Replies', tone: 'purple', types: ['reply_received'] },
         { label: 'Manual needed', tone: 'amber', types: ['manual_apply'] },
         { label: 'Failed', tone: 'red', types: ['error'] }]
      : [{ label: 'Jobs found', tone: 'indigo', types: ['job_identified'] },
         { label: 'Relevant', tone: 'amber', types: ['relevant'] },
         { label: 'Applied', tone: 'green', types: ['applied', 'easy_apply'] },
         { label: 'Manual needed', tone: 'amber', types: ['manual_apply'] },
         { label: 'Failed', tone: 'red', types: ['error'] }];

    const count = (c: Cell) => c.types.includes('manual_apply')
      ? list(c.types).filter((e) => !done.has(e.url || e.id)).length
      : list(c.types).length;
    const selectedCell = sel?.portal === portal ? cells.find((c) => c.label === sel.label) : null;

    return (
      <div className="card card-pad" key={portal}>
        <div className="card-title">
          <Icon name={portal === 'linkedin' ? 'link' : 'target'} size={15} />
          {portal === 'linkedin' ? 'LinkedIn' : 'Indeed'}
          <span className="faint" style={{ fontSize: 12, fontWeight: 400, marginLeft: 6 }}>· tap a tile to see the jobs</span>
        </div>
        <div className="mtile-grid">
          {cells.map((c) => {
            const v = count(c);
            const active = selectedCell?.label === c.label;
            return (
              <button key={c.label} className={`mtile mtile-btn ${active ? 'sel' : ''}`}
                style={mtileStyle(v ? TONE_COLOR[c.tone] : 'var(--text-faint)')}
                onClick={() => setSel(active ? null : { portal, label: c.label })}>
                <span className="mtile-num">{v}</span>
                <span className="mtile-label">{c.label}</span>
              </button>
            );
          })}
        </div>
        {selectedCell && (
          <MetricList portal={portal} cell={selectedCell} rows={list(selectedCell.types)}
            done={done} onDone={dismiss} />
        )}
      </div>
    );
  };

  return <div style={{ display: 'grid', gap: 14 }}>{block('linkedin')}{block('indeed')}</div>;
}

// Manual-apply completions are tracked per-day in localStorage, so the list resets every
// day on its own (a new date → a fresh, empty key).
const doneKey = () => `manualDone:${new Date().toISOString().slice(0, 10)}`;
function loadDone(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(doneKey()) || '[]')); } catch { return new Set(); }
}

/** The expandable list under a selected metric tile. */
function MetricList({ portal, cell, rows, done, onDone }: {
  portal: string; cell: { label: string; types: string[] };
  rows: AgentEvent[]; done: Set<string>; onDone: (key: string) => void;
}) {
  const [asked, setAsked] = useState<Record<string, boolean>>({});
  const isManual = cell.types.includes('manual_apply');
  const visible = isManual ? rows.filter((e) => !done.has(e.url || e.id)) : rows;

  if (visible.length === 0) {
    return <div className="metric-list faint" style={{ fontSize: 12.5 }}>
      Nothing under “{cell.label}” yet today.
    </div>;
  }
  return (
    <div className="metric-list">
      {isManual && <div className="kv-k" style={{ marginBottom: 6 }}>
        Open each and apply on {portal === 'linkedin' ? 'LinkedIn' : 'the site'} — we’ll ask if you did.
      </div>}
      {visible.slice(0, 25).map((e) => {
        const key = e.url || e.id;
        return (
          <div key={e.id} className="metric-row">
            <a href={e.url} target="_blank" rel="noreferrer" className="metric-row-title"
              onClick={() => { if (isManual) setAsked((a) => ({ ...a, [key]: true })); }}>
              {e.title || 'Job'}{e.company ? <span className="faint"> · {e.company}</span> : ''}
            </a>
            {isManual && asked[key] ? (
              <span className="row" style={{ gap: 6, flex: 'none' }}>
                <span className="faint" style={{ fontSize: 12 }}>Applied?</span>
                <button className="btn btn-sm btn-primary" onClick={() => onDone(key)}>Yes</button>
                <button className="btn btn-sm" onClick={() => setAsked((a) => ({ ...a, [key]: false }))}>Not yet</button>
              </span>
            ) : (
              <span className="faint" style={{ fontSize: 11.5, flex: 'none' }}>
                {e.url && <Icon name="external" size={12} style={{ marginRight: 6 }} />}{fmtDate(e.createdAt)}
              </span>
            )}
          </div>
        );
      })}
      {isManual && <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
        This list clears itself every day. Also emailed to you each evening.
      </div>}
    </div>
  );
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
