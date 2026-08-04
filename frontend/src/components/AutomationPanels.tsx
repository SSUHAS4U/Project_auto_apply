import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { api } from '../api/client';
import type { AgentEvent, AgentRunInfo, AgentStatus } from '../types';
import { fmtDate, useToast } from '../lib/ui';
import { Icon } from './Icon';
import { JobCardV2 } from './JobCardV2';
import { useProfileSkills } from '../lib/useProfileSkills';
import { Modal } from './Modal';
import { TerminalConsole } from './DesktopTerminal';
import { isDesktopApp } from '../lib/desktop';

/**
 * Shared automation panels for the unified Engine page: per-portal
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

// ---- Run controls (the header actions) --------------------------------------

/**
 * Start the automation NOW (or pause/stop a live run). The scheduled blocks
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
  const inApp = isDesktopApp();   // starting a run needs the local worker
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
      {/* EVERY run control is desktop-only. The automation is driven by the local worker, so
          Run / Pause / Stop belong where that worker lives; the web is a read-only view of what
          the automation has done. */}
      {!inApp ? (
        <span className="faint" style={{ fontSize: 12.5 }}>Runs are controlled in JobPilot Desktop</span>
      ) : live ? (
        <>
          <button className="btn btn-sm" onClick={pause} disabled={busy}>
            <Icon name={status?.paused ? 'play' : 'pause'} size={13} /> {status?.paused ? 'Resume' : 'Pause'}
          </button>
          <button className="btn btn-sm btn-danger-solid" onClick={stop} disabled={busy}><Icon name="x" size={13} /> Stop</button>
        </>
      ) : (
        <>
          <button className="btn btn-primary btn-sm" onClick={() => start('linkedin')} disabled={busy || !online}
            title={online ? 'Run a LinkedIn block now' : 'The automation is still starting'}>
            <Icon name="play" size={13} /> Run LinkedIn
          </button>
          <button className="btn btn-sm" onClick={() => start('indeed')} disabled={busy || !online}
            title={online ? 'Run an Indeed block now' : 'The automation is still starting'}>
            <Icon name="play" size={13} /> Run Indeed
          </button>
        </>
      )}
      {/* Terminal stays right here in the Auto Apply header (it's ALSO in the floating hub). */}
      <TerminalButton />
    </div>
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

// ---- Per-portal metrics (LinkedIn vs Indeed) --------------------------------

export function PortalMetrics({ only }: { only?: 'linkedin' | 'indeed' } = {}) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  useEffect(() => {
    const pull = () => api.agentEvents(1000).then(setEvents).catch(() => {});
    pull();
    const t = setInterval(pull, 8000);
    return () => clearInterval(t);
  }, []);

  // The tiles count activity over the SELECTED range (Day / Week / Month / Year), so the same
  // numbers can be read for today or the whole year. Default Day — that's the live view, and it
  // avoids stale errors from earlier days piling up.
  const [range, setRange] = useState<'day' | 'week' | 'month' | 'year'>('day');
  const since = (() => {
    const d = new Date();
    if (range === 'day') d.setHours(0, 0, 0, 0);
    else if (range === 'week') d.setDate(d.getDate() - 7);
    else if (range === 'month') d.setDate(d.getDate() - 30);
    else d.setFullYear(d.getFullYear() - 1);
    return d.getTime();
  })();
  const scoped = events.filter((e) => e.createdAt && new Date(e.createdAt).getTime() >= since);

  const [sel, setSel] = useState<{ portal: string; label: string } | null>(null);
  const [done, setDone] = useState<Set<string>>(() => loadDone());
  const dismiss = (key: string) => setDone((prev) => {
    const next = new Set(prev); next.add(key);
    try { localStorage.setItem(doneKey(), JSON.stringify([...next])); } catch { /* ignore */ }
    return next;
  });

  const block = (portal: 'linkedin' | 'indeed') => {
    const ev = scoped.filter((e) => e.portal === portal);
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
         { label: 'Failed', tone: 'red', types: ['apply_failed'] }]
      : [{ label: 'Jobs found', tone: 'indigo', types: ['job_identified'] },
         { label: 'Relevant', tone: 'amber', types: ['relevant'] },
         { label: 'Applied', tone: 'green', types: ['applied', 'easy_apply'] },
         { label: 'Manual needed', tone: 'amber', types: ['manual_apply'] },
         { label: 'Failed', tone: 'red', types: ['apply_failed'] }];

    // Count DISTINCT JOBS, not events. The same job appears in every city search, so counting
    // raw events multiplied everything (7 jobs across 6 cities read as 40+). Dedupe by job
    // identity — its URL, else title+company — so each tile is "how many jobs", which is what
    // the labels claim and what makes the numbers reconcile with the applied list.
    const jobKey = (e: AgentEvent) => (e.url || '').trim()
      || ((e.title || '') + '|' + (e.company || '')).toLowerCase().trim();
    const count = (c: Cell) => {
      const seen = new Set<string>();
      let n = 0;
      for (const e of list(c.types)) {
        if (c.types.includes('manual_apply') && done.has(e.url || e.id)) continue;
        const k = jobKey(e);
        if (k && k !== '|') { if (seen.has(k)) continue; seen.add(k); }
        n++;
      }
      return n;
    };
    const selectedCell = sel?.portal === portal ? cells.find((c) => c.label === sel.label) : null;

    return (
      <div className="card card-pad" key={portal}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="card-title" style={{ marginBottom: 0 }}>
            <Icon name={portal} size={15} />
            {portal === 'linkedin' ? 'LinkedIn' : 'Indeed'}
            <span className="faint" style={{ fontSize: 12, fontWeight: 400, marginLeft: 6 }}>· tap a stat to see the jobs</span>
          </div>
          {/* No settings gear here — the per-day caps live in Automation → Schedule with the
              rest of the cadence, so there is one place to configure the automation. */}
          <div className="ac-range">
            {(['day', 'week', 'month', 'year'] as const).map((r) => (
              <button key={r} className={`ac-range-b ${range === r ? 'on' : ''}`} onClick={() => setRange(r)}>
                {r[0].toUpperCase() + r.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="pstat">
          {cells.map((c) => {
            const v = count(c);
            const active = selectedCell?.label === c.label;
            return (
              <button key={c.label} className={`pstat-cell ${active ? 'sel' : ''} ${v ? '' : 'zero'}`}
                style={{ ['--sc']: v ? TONE_COLOR[c.tone] : 'var(--text-faint)' } as CSSProperties}
                onClick={() => setSel(active ? null : { portal, label: c.label })}>
                <span className="pstat-n">{v}</span>
                <span className="pstat-l">{c.label}</span>
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

  return (
    <div className="portal-panel">
      {(!only || only === 'linkedin') && block('linkedin')}
      {(!only || only === 'indeed') && block('indeed')}
    </div>
  );
}

// Manual-apply completions are tracked per-day in localStorage, so the list resets every
// day on its own (a new date → a fresh, empty key).
const doneKey = () => `manualDone:${new Date().toISOString().slice(0, 10)}`;
function loadDone(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(doneKey()) || '[]')); } catch { return new Set(); }
}

/** The expandable list under a selected metric — one rich card per job (real logo, meta, fit %). */
function MetricList({ portal, cell, rows, done, onDone }: {
  portal: string; cell: { label: string; types: string[] };
  rows: AgentEvent[]; done: Set<string>; onDone: (key: string) => void;
}) {
  const [asked, setAsked] = useState<Record<string, boolean>>({});
  const skills = useProfileSkills();
  const isManual = cell.types.includes('manual_apply');
  const visible = isManual ? rows.filter((e) => !done.has(e.url || e.id)) : rows;
  const portalName = portal === 'linkedin' ? 'LinkedIn' : 'Indeed';

  if (visible.length === 0) {
    return <div className="metric-list faint" style={{ fontSize: 12.5 }}>
      Nothing under “{cell.label}” yet today.
    </div>;
  }
  return (
    <div className="metric-list">
      {isManual && <div className="kv-k" style={{ marginBottom: 6 }}>
        Open each and apply on {portalName} — we’ll ask if you did.
      </div>}
      {visible.slice(0, 25).map((e) => {
        const key = e.url || e.id;
        const fitN = Number((e.detail || '').match(/fit\s+(\d+)/i)?.[1]);
        const fit = Number.isFinite(fitN) && fitN > 0 ? fitN : null;
        return (
          <JobCardV2 key={e.id}
            title={e.title || 'Role'}
            company={e.company}
            description={e.description}
            url={e.url}
            source={portal}
            postedLabel={fmtDate(e.createdAt)}
            salaryText={e.salary}
            score={fit ?? undefined}
            skills={skills}
            actions={isManual && asked[key] ? (
              <>
                <button className="btn btn-sm btn-primary" onClick={() => onDone(key)}>Applied</button>
                <button className="btn btn-sm" onClick={() => setAsked((a) => ({ ...a, [key]: false }))}>Not yet</button>
              </>
            ) : (
              <a className="btn btn-primary btn-sm" href={e.url} target="_blank" rel="noreferrer"
                onClick={() => { if (isManual) setAsked((a) => ({ ...a, [key]: true })); }}>Open ↗</a>
            )} />
        );
      })}
      {isManual && <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
        This list clears itself every day. Also emailed to you each evening.
      </div>}
    </div>
  );
}

// ---- Per-portal panel (LinkedIn / Indeed tabs) ------------------------------

/** Everything the automation does on ONE portal: its metrics + job lists and that portal's
 *  live activity feed. (Outreach/email lives in Connections, next to its toggles.) */
export function PortalPanel({ portal }: { portal: 'linkedin' | 'indeed' }) {
  const name = portal === 'linkedin' ? 'LinkedIn' : 'Indeed';
  return (
    // .portal-panel, not an inline grid: its rows need min-width:0 or the metrics strip's
    // min-content width (~930px) pushes the whole page sideways on a narrow screen.
    <div className="portal-panel">
      <PortalMetrics only={portal} />
      {portal === 'linkedin' && <FlowBreakdownLive />}
      <div className="section-title" style={{ margin: '4px 0 0' }}><Icon name="live" size={15} /> {name} activity</div>
      {/* Activity says WHAT happened; the Runs card beside it says WHEN — is it running right
          now, when did the last run finish, when does the next one start. */}
      <div className="run-wrap">
        <div className="run-split">
          <ActivityFeed portal={portal} />
          <RunStatusCard portal={portal} />
        </div>
      </div>
    </div>
  );
}

// ---- The four LinkedIn automations, counted separately ----------------------

/** key → label + what it does, in the order they run. */
const FLOWS: [string, string, string][] = [
  ['easyApply', 'Easy Apply', 'Searches jobs and applies where LinkedIn allows one-click'],
  ['postApply', 'Post scan & apply', 'Reads hiring posts → apply link, message the author, or email'],
  ['emailOutreach', 'Recruiter emails', 'Harvests addresses from posts and sends a tailored application'],
  ['connections', 'Connections', 'Invites verified recruiters, then the staged follow-ups'],
];

/** Which event types each flow is judged by — what it produced, not merely that it ran. */
const FLOW_RESULT: Record<string, { types: string[]; noun: string }> = {
  easyApply: { types: ['easy_apply', 'applied'], noun: 'applied' },
  postApply: { types: ['post_analysed'], noun: 'posts read' },
  emailOutreach: { types: ['email_sent'], noun: 'emailed' },
  connections: { types: ['connection_sent', 'message_sent'], noun: 'contacted' },
};

/**
 * Per-flow results for LinkedIn. The four automations used to be one "Phase 2", so a quiet run
 * could mean any of four different things — this says which one produced what.
 */
export function FlowBreakdown({ events }: { events: AgentEvent[] }) {
  const li = events.filter((e) => e.portal === 'linkedin');
  return (
    <div className="card card-pad">
      <div className="section-title" style={{ marginBottom: 4 }}>
        <Icon name="bolt" size={15} /> The four LinkedIn automations
      </div>
      <div className="faint" style={{ fontSize: 12.5, marginBottom: 14 }}>
        Each runs on its own budget and can be switched off in Schedule.
      </div>
      <div className="flow-grid">
        {FLOWS.map(([key, label, what]) => {
          const r = FLOW_RESULT[key];
          const produced = li.filter((e) => e.flow === key && r.types.includes(e.type)).length;
          // Events recorded before flows existed have no `flow`, so "ran" counts anything tagged.
          const ran = li.some((e) => e.flow === key);
          return (
            <div key={key} className={`flow-cell ${produced > 0 ? 'has' : ''}`}>
              <div className="flow-n">{produced}</div>
              <div className="flow-l">{r.noun}</div>
              <div className="flow-t">{label}</div>
              <div className="flow-w">{what}</div>
              {!ran && <div className="flow-idle">hasn’t run yet</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One automation's switch + time budget. The switch is the point: turning a flow off must leave
 * the other three running, so a problem in one doesn't cost you the whole block.
 */
function FlowRow({ k, label, hint, cfg, set }: {
  k: string; label: string; hint: string;
  cfg: Record<string, number | boolean>; set: (key: string, v: number | boolean) => void;
}) {
  const on = cfg[`${k}On`] !== false;
  return (
    <label className="set-f">
      <span className="set-l">{label}</span>
      <span className="set-h">{hint}</span>
      <div className="set-in">
        <button type="button" className={`btn btn-sm ${on ? 'btn-primary' : ''}`}
          onClick={() => set(`${k}On`, !on)} style={{ minWidth: 62 }}>
          {on ? 'On' : 'Off'}
        </button>
        <input className="input" type="number" min={0} style={{ width: 78 }}
          disabled={!on}
          value={num(cfg[`${k}Mins`])}
          onChange={(e) => set(`${k}Mins`, Number(e.target.value))} />
        <span className="set-u">minutes</span>
      </div>
    </label>
  );
}

/** Self-fetching wrapper so PortalPanel doesn't have to thread events down. */
function FlowBreakdownLive() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  useEffect(() => {
    const pull = () => api.agentEvents(1000).then(setEvents).catch(() => {});
    pull();
    const t = setInterval(pull, 15000);
    return () => clearInterval(t);
  }, []);
  return <FlowBreakdown events={events} />;
}

// ---- Runs card: is it running, when was the last one, when is the next ------

/** "8m", "1h 22m", "2d 3h" — a duration in the smallest units that stay readable. */
function fmtDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Display name for a portal key. */
const portalName = (p: string) =>
  p === 'linkedin' ? 'LinkedIn' : p === 'indeed' ? 'Indeed' : p.charAt(0).toUpperCase() + p.slice(1);

/** "today 20:00" / "tomorrow 09:30" / "12 Aug, 09:30" — a clock time you can act on. */
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (a: Date) => new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const days = Math.round((day(d) - day(new Date())) / 86400000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

/**
 * The "when" panel for a portal page. The automation starts itself now, so without this there
 * is no way to tell a run that is quietly working from one that never started.
 */
export function RunStatusCard({ portal }: { portal: 'linkedin' | 'indeed' }) {
  const [info, setInfo] = useState<AgentRunInfo | null>(null);
  const [failed, setFailed] = useState(false);
  // Re-render on a timer as well as on fetch, so "running for 12m" keeps counting up.
  const [, tick] = useState(0);

  useEffect(() => {
    let alive = true;
    // Drop the previous portal's data the instant we switch. Without this the Indeed page keeps
    // showing LinkedIn's last run until the new fetch lands — which reads as "the history takes
    // ages to change", when in fact it was showing the wrong portal the whole time.
    setInfo(null);
    setFailed(false);
    const pull = () => api.agentRunInfo(portal)
      // Ignore a late reply for the portal we just navigated away from.
      .then((r) => { if (alive && r.portal === portal) { setInfo(r); setFailed(false); } })
      .catch(() => { if (alive) setFailed(true); });
    pull();
    const t = setInterval(pull, 5000);
    const t2 = setInterval(() => alive && tick((n) => n + 1), 30000);
    return () => { alive = false; clearInterval(t); clearInterval(t2); };
  }, [portal]);

  const name = portal === 'linkedin' ? 'LinkedIn' : 'Indeed';
  if (failed && !info) {
    return (
      <div className="card card-pad run-card">
        <div className="run-card-h"><Icon name="clock" size={15} /> Runs</div>
        <div className="faint" style={{ fontSize: 12.5 }}>Couldn’t load run times — retrying.</div>
      </div>
    );
  }
  if (!info) return <div className="card card-pad run-card"><span className="spinner" /></div>;

  const cur = info.current;
  const live = !!cur && ['running', 'queued', 'needs_attention'].includes(cur.status);
  const state = info.paused ? 'paused' : live ? 'running' : 'idle';
  const tone = { running: 'green', paused: 'amber', idle: 'slate' }[state];
  const label = { running: `Running${cur?.status === 'queued' ? ' · starting' : ''}`, paused: 'Paused', idle: 'Not running' }[state];

  return (
    <div className="card card-pad run-card">
      <div className="run-card-h"><Icon name="clock" size={15} /> {name} runs</div>

      {/* Now — the answer to "has it actually started?" */}
      <div className="run-now">
        <span className={`tone tone-${tone} ${live ? 'live-pulse' : ''}`} style={{ padding: '4px 10px' }}>
          <span className="live-dot" /> {label}
        </span>
        {live && cur?.startedAt && (
          <div className="run-since">
            Started {fmtWhen(cur.startedAt)} · running for {fmtDuration(Date.now() - new Date(cur.startedAt).getTime())}
          </div>
        )}
        {live && cur?.currentAction && <div className="run-action">{cur.currentAction}</div>}
        {live && cur && (
          <div className="run-tally">
            {cur.applied} applied · {cur.searched} seen
            {portal === 'linkedin' && ` · ${cur.connected} connected`}
          </div>
        )}
        {!live && info.paused && <div className="run-since">Resume it to start the next run.</div>}
        {!live && !info.paused && info.busyWith && (
          <div className="run-since">Waiting — the {info.busyWith} run has to finish first.</div>
        )}
        {!live && !info.paused && !info.busyWith && !info.workerOnline && (
          <div className="run-since">Open JobPilot Desktop — runs need it open.</div>
        )}
      </div>

      <Line label="Previous run" >
        {info.previous?.startedAt ? (
          <>
            <b>{fmtWhen(info.previous.startedAt)}</b>
            {info.previous.endedAt && (
              <span className="faint"> · ran {fmtDuration(
                new Date(info.previous.endedAt).getTime() - new Date(info.previous.startedAt).getTime())}</span>
            )}
            <div className="faint" style={{ fontSize: 12 }}>
              {info.previous.applied} applied
              {info.previous.status === 'failed' && <span style={{ color: 'var(--red)' }}> · stopped early</span>}
            </div>
          </>
        ) : <span className="faint">No finished run yet</span>}
      </Line>

      <Line label="Next run">
        {info.paused ? <span className="faint">Paused — nothing scheduled</span>
          : live ? <span className="faint">After this one finishes</span>
          : !info.workerOnline ? <span className="faint">Waiting for JobPilot Desktop</span>
          : info.quotaMet ? (
            // Nothing owed today — say so plainly rather than showing tomorrow's midnight as
            // if it were a scheduled start.
            <><b>Tomorrow</b><div className="faint" style={{ fontSize: 12 }}>
              today’s {name} quota is done</div></>
          ) : info.nextAt ? (
            // A next time in the past means the window is open and it is due right now.
            new Date(info.nextAt).getTime() <= Date.now() + 60000
              ? <><b>Due now</b><div className="faint" style={{ fontSize: 12 }}>
                  Starting within a few minutes</div></>
              : <><b>{fmtWhen(info.nextAt)}</b><div className="faint" style={{ fontSize: 12 }}>
                  in {fmtDuration(new Date(info.nextAt).getTime() - Date.now())}</div></>
          ) : info.nextPortal ? (
            // Work IS owed, but the other portal goes first. How long that takes depends on how
            // long its block runs, so a clock time here would be invented.
            <><b>After {portalName(info.nextPortal)}</b><div className="faint" style={{ fontSize: 12 }}>
              {portalName(info.nextPortal)} runs first — this follows it</div></>
          ) : <span className="faint">Nothing owed right now</span>}
      </Line>
    </div>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="run-line">
      <div className="run-line-l">{label}</div>
      <div className="run-line-v">{children}</div>
    </div>
  );
}

// ---- Activity feed ----------------------------------------------------------

export function ActivityFeed({ portal }: { portal?: string } = {}) {
  const [all, setAll] = useState<AgentEvent[]>([]);
  useEffect(() => {
    const pull = () => api.agentEvents(120).then(setAll).catch(() => {});
    pull();
    const t = setInterval(pull, 4000);
    return () => clearInterval(t);
  }, []);

  const events = portal ? all.filter((e) => e.portal === portal) : all;
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

// ---- Cadence editor (was: start-time schedule) ------------------------------

/**
 * How the automation paces itself. The old editor asked WHEN each block should start, which
 * made no sense once the automation runs whenever the desktop app is open — so this asks HOW
 * MUCH instead: how long each phase runs, how many applications per portal per day, and how
 * long to rest in between. The daily counts carry over: whatever a run doesn't finish is left
 * for the next one.
 */
/** A settings value as a number — the map also carries the flow on/off booleans. */
const num = (v: number | boolean | undefined) => (typeof v === 'number' ? v : 0);

/**
 * The actual searches the next run will perform.
 *
 * "12 keyword variants" and "6 locations" are meaningless as bare numbers — you cannot tell
 * whether 12 is sensible without seeing what it produces. This shows the real terms and cities,
 * so the settings above explain themselves.
 */
function SearchPreview({ portal, maxKeywords, maxLocations, pages }: {
  portal: 'linkedin' | 'indeed'; maxKeywords: number; maxLocations: number; pages: number;
}) {
  const [p, setP] = useState<{ keywords: string[]; locations: string[] } | null>(null);
  const [failed, setFailed] = useState(false);

  // The terms and cities come from the server ONCE — they're derived from your profile and
  // can't be computed here. Everything else is arithmetic on the live inputs, so dragging a
  // number updates the totals as you type instead of waiting for a save and a round-trip.
  useEffect(() => {
    let alive = true;
    setP(null); setFailed(false);
    api.agentSearchPreview(portal)
      .then((r) => { if (alive) setP(r); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [portal]);

  if (failed) return null;                       // never replace a setting with an error
  if (!p) return <div className="sp-wrap"><span className="spinner" /></div>;

  const allTerms = p.keywords || [];
  const allCities = p.locations || [];
  // The settings are ceilings. What actually runs is whichever is smaller: the ceiling, or how
  // many terms/cities your profile really produces.
  const terms = allTerms.slice(0, Math.max(0, maxKeywords));
  const cities = allCities.slice(0, Math.max(0, maxLocations));
  const perPage = portal === 'linkedin' ? 25 : 15;
  const pg = Math.max(1, pages);
  const searches = terms.length * cities.length;
  const reach = searches * pg * perPage;
  const capped = allTerms.length > terms.length || allCities.length > cities.length;
  const short = maxKeywords > allTerms.length || maxLocations > allCities.length;

  return (
    <div className="sp-wrap">
      <div className="sp-calc">
        <div className="sp-sum">
          <b>{searches}</b> searches → up to <b>~{reach.toLocaleString()}</b> listings per run
        </div>
        <div className="sp-math">
          {terms.length} term{terms.length === 1 ? '' : 's'} × {cities.length} cit{cities.length === 1 ? 'y' : 'ies'} = <b>{searches}</b> searches
          <span className="sp-x">·</span>
          {searches} × {pg} page{pg === 1 ? '' : 's'} × {perPage} per page = <b>~{reach.toLocaleString()}</b>
        </div>
      </div>
      <div className="sp-row">
        <span className="sp-k">Terms</span>
        <span className="sp-v">
          {terms.length === 0
            ? <em className="faint">none yet — add target roles in Setup</em>
            : terms.map((t) => <span key={t} className="chip">{t}</span>)}
        </span>
      </div>
      <div className="sp-row">
        <span className="sp-k">Cities</span>
        <span className="sp-v">
          {cities.length === 0
            ? <em className="faint">none yet — add locations in Setup</em>
            : cities.map((c) => <span key={c} className="chip">{c}</span>)}
        </span>
      </div>
      {capped && (
        <div className="sp-note">
          Your limits are cutting the list short — {allTerms.length} terms and {allCities.length} cities
          are available. Raise them above to use all of them.
        </div>
      )}
      {short && !capped && (
        <div className="sp-note">
          You have fewer terms/cities than your limits allow, so raising them changes nothing.
          More terms come from adding skills in Profile; more cities from Setup.
        </div>
      )}
    </div>
  );
}

/**
 * Settings for ONE portal. The editor used to render every setting on both portal pages, so
 * LinkedIn's page showed Indeed's caps and vice versa — the same screen twice, with half of it
 * irrelevant wherever you were standing.
 */
export function ScheduleEditor({ portal }: { portal?: 'linkedin' | 'indeed' } = {}) {
  const toast = useToast();
  const [cfg, setCfg] = useState<Record<string, number | boolean> | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.agentLimits().then((l) => setCfg(l as unknown as Record<string, number | boolean>)).catch(() => {});
  }, []);

  const set = (k: string, v: number | boolean) => setCfg((c) => ({ ...(c || {}), [k]: v }));
  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      setCfg(await api.agentSetLimits(cfg) as unknown as Record<string, number | boolean>);
      toast('Automation settings saved', 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setSaving(false); }
  };

  if (!cfg) return <div className="empty"><span className="spinner" /></div>;

  const isLi = portal !== 'indeed';
  const name = isLi ? 'LinkedIn' : 'Indeed';

  /** One numeric setting. Label, hint and field stack — nothing truncates at any width. */
  const F = ({ k, label, hint, unit }: { k: string; label: string; hint: string; unit: string }) => (
    <label className="set-f">
      <span className="set-l">{label}</span>
      <span className="set-h">{hint}</span>
      <span className="set-in">
        <input className="input" type="number" min={0}
          value={num(cfg[k])} onChange={(e) => set(k, Number(e.target.value))} />
        <span className="set-u">{unit}</span>
      </span>
    </label>
  );

  const Group = ({ icon, title, blurb, children }: {
    icon: string; title: string; blurb: string; children: ReactNode;
  }) => (
    <section className="set-group">
      <div className="set-head">
        <span className="set-ico"><Icon name={icon} size={15} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="set-title">{title}</div>
          <div className="set-blurb">{blurb}</div>
        </div>
      </div>
      <div className="set-grid">{children}</div>
    </section>
  );

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="card card-pad">
        <Group icon="clock" title={'How much ' + name + ' does'}
          blurb={"Runs whenever JobPilot Desktop is open — there are no start times to set. Anything a run doesn't finish carries over to the next one."}>
          {isLi ? (
            <>
              <F k="linkedinApplyCap" label="Applications" hint="the daily target" unit="per day" />
              <F k="linkedinApplyMins" label="Easy Apply time" hint="searching and applying" unit="minutes" />
              <F k="linkedinOutreachMins" label="Outreach time" hint="posts, emails, connections" unit="minutes" />
            </>
          ) : (
            <>
              <F k="indeedApplyCap" label="Applications" hint="the daily target" unit="per day" />
              <F k="indeedMins" label="Block length" hint="Indeed only applies" unit="minutes" />
            </>
          )}
          <F k="restMins" label="Rest between blocks" hint="shared by both portals" unit="minutes" />
        </Group>

        <Group icon="target" title="What it applies to"
          blurb="Nothing is applied to unless your résumé matches its stack. Raise these to apply less and better; lower them to cast wider.">
          <F k="fitMin" label="Minimum résumé fit" hint="a job scoring below this is skipped" unit="out of 100" />
          <F k="maxAgeDays" label="Skip jobs older than" hint="stale postings are usually filled" unit="days" />
        </Group>

        {/* These are CEILINGS, not counts. Stating "that is 72 searches" here contradicted the
            preview below, which showed 36 — the real number, because you only have 6 search
            terms. The preview is the truth; this just explains the mechanic. */}
        <Group icon="search" title="How wide it searches"
          blurb={`Upper limits: every search term is searched in every city, and each search reads several result pages. The real numbers are below — raising these only helps if you have the terms and cities to fill them.`}>
          <F k="maxKeywords" label="Search terms" hint="max — built from your roles + skills" unit="at most" />
          <F k="maxLocations" label="Cities" hint="max — from your Setup locations" unit="at most" />
          <F k="pagesPerSearch" label="Pages per search"
            hint={isLi ? 'LinkedIn shows 25 jobs a page' : 'Indeed shows ~15 jobs a page'} unit="pages" />
        </Group>

        {/* Live values, not saved ones: the totals recalculate as you type. */}
        <SearchPreview portal={isLi ? 'linkedin' : 'indeed'}
          maxKeywords={num(cfg.maxKeywords)} maxLocations={num(cfg.maxLocations)}
          pages={num(cfg.pagesPerSearch)} />

        {isLi && (
          <>
            <section className="set-group">
              <div className="set-head">
                <span className="set-ico"><Icon name="bolt" size={15} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="set-title">The four LinkedIn automations</div>
                  <div className="set-blurb">
                    Each gets its own slice of the block. Switching one off leaves the others running.
                  </div>
                </div>
              </div>
              <div className="set-grid">
                <FlowRow k="easyApply" label="Easy Apply" hint="search and one-click apply" cfg={cfg} set={set} />
                <FlowRow k="postApply" label="Post scan & apply" hint="posts → link, message or email" cfg={cfg} set={set} />
                <FlowRow k="emailOutreach" label="Recruiter emails" hint="addresses found in posts" cfg={cfg} set={set} />
                <FlowRow k="connections" label="Connections" hint="invites and follow-ups" cfg={cfg} set={set} />
              </div>
            </section>

            <Group icon="link" title="Outreach limits"
              blurb="What stops outreach looking like spam — and protects your account. The same person is never contacted twice about the same role, whatever these say.">
              <F k="perDay" label="Total outreach" hint="per day, all companies" unit="people" />
              <F k="perCompanyPerDay" label="Per company" hint="at most this many people at one employer" unit="per day" />
              <F k="recruiterCooldownDays" label="Same person cooldown" hint="before contacting them again" unit="days" />
              <F k="personConfMin" label="Minimum certainty they hire" hint="to contact them at all" unit="out of 100" />
              <F k="postScanTarget" label="Hiring posts to read" hint="per day — where new leads come from" unit="posts" />
              <F k="outreachBlocksPerDay" label="Extra outreach blocks" hint="after the apply quota is met" unit="per day" />
            </Group>

            <Group icon="send" title="Follow-up sequence"
              blurb="Days to wait after the previous message. Most replies come from the second or third touch; after the fourth the contact is archived and never messaged again.">
              <F k="followUp1" label="1st follow-up" hint="after they accept" unit="days later" />
              <F k="followUp2" label="2nd follow-up" hint="after the 1st" unit="days later" />
              <F k="followUp3" label="3rd follow-up" hint="after the 2nd" unit="days later" />
              <F k="followUp4" label="4th and final" hint="then archived" unit="days later" />
            </Group>
          </>
        )}

        <div className="set-actions">
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <span className="spinner" /> : <Icon name="check" size={14} />} Save settings
          </button>
          <span className="faint" style={{ fontSize: 12.5 }}>
            {isLi
              ? 'A LinkedIn block runs ' + (num(cfg.linkedinApplyMins) + num(cfg.linkedinOutreachMins))
                + 'm, then rests ' + num(cfg.restMins) + 'm.'
              : 'An Indeed block runs ' + num(cfg.indeedMins) + 'm, then rests ' + num(cfg.restMins) + 'm.'}
          </span>
        </div>
      </div>

      <div className="card card-pad set-cycle">
        <b>What a {name} block does</b>
        <div className="faint" style={{ marginTop: 8, lineHeight: 1.85 }}>
          {isLi ? (
            <>
              1. <b>Easy Apply</b> — until {num(cfg.linkedinApplyCap)} applications or {num(cfg.linkedinApplyMins)}m<br />
              2. <b>Post scan &amp; apply</b> — hiring posts → apply link, message the author, or email<br />
              3. <b>Recruiter emails</b> — addresses found in posts<br />
              4. <b>Connections</b> — invite verified recruiters, then the staged follow-ups<br />
              5. <b>Rest</b> {num(cfg.restMins)}m, then whichever portal ran longest ago goes next.
            </>
          ) : (
            <>
              1. <b>Search &amp; apply</b> — until {num(cfg.indeedApplyCap)} applications or {num(cfg.indeedMins)}m.
              Indeed has no outreach phase; it only applies.<br />
              2. <b>Rest</b> {num(cfg.restMins)}m, then whichever portal ran longest ago goes next.
            </>
          )}
          <br />Once both portals meet their daily quota, nothing runs until tomorrow.
        </div>
      </div>
    </div>
  );
}
