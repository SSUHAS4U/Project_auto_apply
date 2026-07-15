import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type {
  AgentEvent, AgentFrame, AgentMessage, AgentRun, AgentSchedule, AgentStatus, PortalContact,
} from '../types';
import { fmtDate, StatIcon, useToast } from '../lib/ui';

/**
 * Agent — mission control for the LOCAL Playwright worker that drives the job portals
 * on the owner's PC. Live screen feed, HireDue-style metric tiles, per-portal Start/Pause,
 * the daily rotation schedule, the draft-first message approvals, and worker onboarding.
 */

type Tab = 'live' | 'activity' | 'network' | 'schedule' | 'connect';

const PORTALS = ['naukri', 'linkedin', 'indeed'];
const EVENT_ICON: Record<string, string> = {
  post_analysed: '🔬', job_identified: '🎯', relevant: '⭐', applied: '📤', easy_apply: '⚡',
  connection_sent: '🤝', message_sent: '💬', email_sent: '✉️', reply_received: '📩',
  error: '⚠️', info: 'ℹ️',
};

function Chip({ text, color }: { text: string; color: string }) {
  return <span className="chip" style={{ background: color + '22', color, borderColor: color + '55' }}>{text}</span>;
}

export function AgentPage() {
  const toast = useToast();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [tab, setTab] = useState<Tab>('live');
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(() => {
    api.agentStatus().then(setStatus).catch((e) => toast(e.message, 'error'));
  }, [toast]);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 4000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const run = status?.activeRun ?? null;
  const live = !!run && ['running', 'queued', 'needs_attention'].includes(run.status);

  const start = async (portal: string) => {
    setBusy(true);
    try { await api.agentStartRun(portal); toast(`${portal} run queued — the worker will pick it up.`, 'success'); loadStatus(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const pause = async () => {
    setBusy(true);
    try { const r = await api.agentPause(!status?.paused); toast(r.paused ? 'Paused' : 'Resumed', 'success'); loadStatus(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const stop = async () => {
    if (!run) return;
    setBusy(true);
    try { await api.agentStopRun(run.id); toast('Run stopped', 'success'); loadStatus(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  const m = status?.metricsToday;
  const tiles: { label: string; value: number; icon: string; color: string }[] = [
    { label: 'Posts analysed', value: m?.postsAnalysed ?? 0, icon: 'posts', color: '#5b5bd6' },
    { label: 'Jobs identified', value: m?.jobsIdentified ?? 0, icon: 'target', color: '#2563eb' },
    { label: 'Relevant', value: m?.relevantJobs ?? 0, icon: 'star', color: '#d97706' },
    { label: 'Applied', value: m?.applied ?? 0, icon: 'send', color: '#16a34a' },
    { label: 'Connections', value: m?.connectionsSent ?? 0, icon: 'link', color: '#7c3aed' },
    { label: 'Messages', value: m?.messagesSent ?? 0, icon: 'chat', color: '#0891b2' },
    { label: 'Replies', value: m?.repliesReceived ?? 0, icon: 'reply', color: '#16a34a' },
    { label: 'Errors', value: m?.errors ?? 0, icon: 'alert', color: '#dc2626' },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            Agent{' '}
            {status && (live
              ? <Chip text={`● ${run?.portal} ${run?.status}`} color="#34d399" />
              : status.paused ? <Chip text="paused" color="#fbbf24" /> : <Chip text="idle" color="#7d8595" />)}
            {status && !status.workerConfigured && <> <Chip text="worker not connected" color="#f87171" /></>}
          </h1>
          <div className="page-sub">
            Your local worker runs a real browser on your PC and applies with your own logged-in
            sessions — you watch it live here. The backend schedules, scores, answers, and records everything.
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {PORTALS.map((p) => (
            <button key={p} className="btn btn-sm" onClick={() => start(p)} disabled={busy || !status?.workerConfigured}
              title={status?.workerConfigured ? `Queue a ${p} run` : 'Connect the worker first'}>
              ▶ {p}
            </button>
          ))}
          <button className="btn btn-sm" onClick={pause} disabled={busy || !status}
            style={status?.paused ? undefined : { background: '#dc2626', borderColor: '#dc2626', color: '#fff' }}>
            {status?.paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          {live && <button className="btn btn-sm" onClick={stop} disabled={busy}>⏹ Stop</button>}
        </div>
      </div>

      {status && !status.workerConfigured && (
        <div className="card card-pad" style={{ marginBottom: 14, borderColor: '#f59e0b', fontSize: 13 }}>
          ⚠ No worker connected yet. Open the <b>Connect</b> tab to generate a token and start the local worker.
        </div>
      )}

      {/* metric tiles — same SVG-icon style as the Dashboard */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 14 }}>
        {tiles.map((t) => (
          <div key={t.label} className="card card-pad">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div className="faint" style={{ fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase' }}>{t.label}</div>
              <StatIcon name={t.icon} color={t.color} />
            </div>
            <div style={{ fontSize: 28, fontWeight: 750, marginTop: 2, letterSpacing: '-.02em' }}>{t.value}</div>
            <div className="faint" style={{ fontSize: 11 }}>today</div>
          </div>
        ))}
      </div>

      <div className="row" style={{ gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {([['live', '📺 Watch Live'], ['activity', '📋 Activity'],
           ['network', `🤝 Network${status?.pendingApprovals ? ` (${status.pendingApprovals})` : ''}`],
           ['schedule', '🗓 Schedule'], ['connect', '🔌 Connect']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} className={`btn btn-sm ${tab === t ? 'btn-primary' : ''}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'live' && <LiveTab run={run} live={live} />}
      {tab === 'activity' && <ActivityTab />}
      {tab === 'network' && <NetworkTab onChange={loadStatus} />}
      {tab === 'schedule' && <ScheduleTab />}
      {tab === 'connect' && <ConnectTab configured={status?.workerConfigured ?? false} onChange={loadStatus} />}
    </>
  );
}

// ---- Watch Live -------------------------------------------------------------

function LiveTab({ run, live }: { run: AgentRun | null; live: boolean }) {
  const [frame, setFrame] = useState<AgentFrame | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try { const f = await api.agentFrame(); if (!stop) setFrame(f); } catch { /* keep last frame */ }
    };
    pull();
    const t = setInterval(pull, 1500);
    return () => { stop = true; clearInterval(t); };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="row card-pad" style={{ justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border,#1f2530)' }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span style={{ color: live ? '#34d399' : '#7d8595' }}>●</span>
            <b>{frame?.action || run?.currentAction || 'Idle'}</b>
          </div>
          <span className="faint" style={{ fontSize: 12 }}>
            {frame?.portal ? `${frame.portal} · ` : ''}{frame?.updatedAt ? fmtDate(frame.updatedAt) : 'no feed yet'}
          </span>
        </div>
        <div style={{ background: '#000', minHeight: 360, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {frame?.hasFrame ? (
            <img ref={imgRef} src={`data:image/jpeg;base64,${frame.imageB64}`} alt="live"
              style={{ width: '100%', maxHeight: 640, objectFit: 'contain' }} />
          ) : (
            <div className="faint" style={{ padding: 40, textAlign: 'center' }}>
              <div style={{ fontSize: 40 }}>📺</div>
              Waiting for the worker's screen feed.<br />Start the local worker and queue a run.
            </div>
          )}
        </div>
      </div>
      {run && (
        <div className="card card-pad row" style={{ gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
          <span>🔎 searched <b>{run.searched}</b></span>
          <span>⭐ relevant <b>{run.evaluated}</b></span>
          <span>📤 applied <b>{run.applied}</b></span>
          <span>🤝 connected <b>{run.connected}</b></span>
          <span>💬 messaged <b>{run.messaged}</b></span>
          <span>⚠️ failed <b>{run.failed}</b></span>
        </div>
      )}
    </div>
  );
}

// ---- Activity feed ----------------------------------------------------------

function ActivityTab() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  useEffect(() => {
    const pull = () => api.agentEvents(80).then(setEvents).catch(() => {});
    pull();
    const t = setInterval(pull, 4000);
    return () => clearInterval(t);
  }, []);

  if (events.length === 0) return <div className="card card-pad empty"><div className="big">📋</div>No activity yet.</div>;
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {events.map((e) => (
        <div key={e.id} className="row card-pad" style={{ gap: 10, alignItems: 'flex-start', borderBottom: '1px solid var(--border,#1f2530)' }}>
          <span style={{ fontSize: 16 }}>{EVENT_ICON[e.type] ?? 'ℹ️'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>
              {e.title ? <a href={e.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>{e.title}</a> : <b>{e.type.replace('_', ' ')}</b>}
              {e.company && <span className="faint"> · {e.company}</span>}
              {e.portal && <span className="faint"> · {e.portal}</span>}
            </div>
            {e.detail && <div className="faint" style={{ fontSize: 12 }}>{e.detail}</div>}
          </div>
          <span className="faint" style={{ fontSize: 11.5, flexShrink: 0 }}>{fmtDate(e.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

// ---- Network (contacts + draft-first approvals) -----------------------------

function NetworkTab({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const [contacts, setContacts] = useState<PortalContact[]>([]);
  const [msgs, setMsgs] = useState<AgentMessage[]>([]);
  const [edit, setEdit] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    api.agentContacts().then(setContacts).catch(() => {});
    api.agentMessages().then(setMsgs).catch(() => {});
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);

  const pending = msgs.filter((x) => x.status === 'pending_approval');
  const approve = async (mm: AgentMessage) => {
    try { await api.agentApproveMessage(mm.id, edit[mm.id] ?? mm.body); toast('Approved — the worker may send it.', 'success'); load(); onChange(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const reject = async (mm: AgentMessage) => {
    try { await api.agentRejectMessage(mm.id); load(); onChange(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h3 style={{ margin: '0 0 8px' }}>Approvals {pending.length > 0 && <Chip text={`${pending.length} waiting`} color="#fbbf24" />}</h3>
        {pending.length === 0 ? (
          <div className="card card-pad faint" style={{ fontSize: 13 }}>
            No drafts waiting. Messages the worker wants to send appear here first — nothing goes out until you approve it.
          </div>
        ) : pending.map((mm) => (
          <div key={mm.id} className="card card-pad" style={{ marginBottom: 8 }}>
            <div className="faint" style={{ fontSize: 12, marginBottom: 6 }}>
              {mm.portal} · {mm.aiDrafted ? 'AI-drafted' : 'template'} · {fmtDate(mm.createdAt)}
            </div>
            <textarea className="input" style={{ width: '100%', minHeight: 70, fontSize: 13 }}
              defaultValue={mm.body} onChange={(e) => setEdit((s) => ({ ...s, [mm.id]: e.target.value }))} />
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={() => approve(mm)}>✓ Approve</button>
              <button className="btn btn-ghost btn-sm" onClick={() => reject(mm)}>✕ Reject</button>
            </div>
          </div>
        ))}
      </div>

      <div>
        <h3 style={{ margin: '0 0 8px' }}>Contacts</h3>
        {contacts.length === 0 ? (
          <div className="card card-pad faint" style={{ fontSize: 13 }}>No contacts discovered yet.</div>
        ) : contacts.map((c) => (
          <div key={c.id} className="card card-pad row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <div>
              <a href={c.profileUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>{c.name || 'Contact'}</a>
              <span className="faint" style={{ fontSize: 12.5 }}>{c.role ? ` · ${c.role}` : ''}{c.company ? ` · ${c.company}` : ''} · {c.portal}</span>
            </div>
            <Chip text={c.connectionStatus} color={c.connectionStatus === 'replied' ? '#34d399' : c.connectionStatus === 'connected' ? '#60a5fa' : c.connectionStatus === 'pending' ? '#fbbf24' : '#7d8595'} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Schedule ---------------------------------------------------------------

function ScheduleTab() {
  const toast = useToast();
  const [blocks, setBlocks] = useState<AgentSchedule[]>([]);
  useEffect(() => { api.agentSchedule().then(setBlocks).catch(() => {}); }, []);

  const upd = (i: number, patch: Partial<AgentSchedule>) =>
    setBlocks((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const save = async () => {
    try { setBlocks(await api.agentSaveSchedule(blocks)); toast('Schedule saved', 'success'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div className="card card-pad">
      <h3 style={{ marginTop: 0 }}>Daily rotation</h3>
      <p className="faint" style={{ fontSize: 13, marginTop: 0 }}>
        The worker runs these blocks in order — e.g. Naukri 09:00 for 2h, then LinkedIn, then Indeed.
        Leave keywords/locations blank to derive them from your profile.
      </p>
      {blocks.map((b, i) => (
        <div key={i} className="card card-pad" style={{ marginBottom: 8, background: 'var(--bg-elev,#0f1219)' }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <b style={{ textTransform: 'capitalize', minWidth: 72 }}>{b.portal}</b>
            <label style={{ fontSize: 12 }}>Start
              <input className="input" style={{ width: 90 }} value={b.startTime ?? ''} placeholder="09:00"
                onChange={(e) => upd(i, { startTime: e.target.value })} /></label>
            <label style={{ fontSize: 12 }}>Mins
              <input className="input" type="number" style={{ width: 80 }} value={b.durationMins}
                onChange={(e) => upd(i, { durationMins: +e.target.value })} /></label>
            <label style={{ fontSize: 12 }}>Apply cap
              <input className="input" type="number" style={{ width: 80 }} value={b.applyCap}
                onChange={(e) => upd(i, { applyCap: +e.target.value })} /></label>
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
      <button className="btn btn-primary btn-sm" onClick={save} style={{ marginTop: 8 }}>Save schedule</button>
    </div>
  );
}

// ---- Connect (worker onboarding) --------------------------------------------

function ConnectTab({ configured, onChange }: { configured: boolean; onChange: () => void }) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const issue = async () => {
    try { const r = await api.agentIssueToken(); setToken(r.token); toast('Token generated — copy it now, it is shown once.', 'success'); onChange(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="card card-pad" style={{ maxWidth: 720 }}>
      <h3 style={{ marginTop: 0 }}>Connect your local worker {configured && <Chip text="connected" color="#34d399" />}</h3>
      <p className="faint" style={{ fontSize: 13 }}>
        The worker runs a real browser on your PC with your own logged-in portal sessions — safest for your
        accounts and free. No portal passwords ever reach this server. Set it up once:
      </p>
      <ol style={{ fontSize: 13.5, lineHeight: 1.7 }}>
        <li>Generate a worker token below (shown once — regenerating replaces the old one).</li>
        <li>In the repo: <code>cd worker &amp;&amp; npm install</code></li>
        <li>Create <code>worker/worker.config.json</code> with your backend URL and the token.</li>
        <li><code>npm start</code> → a browser opens. Log into Naukri. Then hit <b>▶ naukri</b> up top.</li>
      </ol>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn btn-primary btn-sm" onClick={issue}>{configured ? 'Regenerate token' : 'Generate token'}</button>
      </div>
      {token && (
        <div style={{ marginTop: 12 }}>
          <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>Your worker token (copy now):</div>
          <pre style={{ userSelect: 'all', background: 'var(--bg-elev,#0f1219)', padding: 10, borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{token}</pre>
          <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
            worker.config.json:
            <pre style={{ background: 'var(--bg-elev,#0f1219)', padding: 10, borderRadius: 8, fontSize: 12, marginTop: 4 }}>{`{
  "backendUrl": "${location.origin.replace('5173', '8080')}",
  "token": "${token}"
}`}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
