import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type {
  AgentEvent, AgentFrame, AgentMessage, AgentRun, AgentSchedule, AgentStatus, PortalContact,
} from '../types';
import { fmtDate, StatIcon, useToast } from '../lib/ui';
import { Icon } from '../components/Icon';

/**
 * Agent — mission control for the LOCAL Playwright worker that drives the job portals
 * on the owner's PC. Live screen feed, HireDue-style metric tiles, per-portal Start/Pause,
 * the daily rotation schedule, the draft-first message approvals, and worker onboarding.
 */

type Tab = 'live' | 'metrics' | 'flows' | 'activity' | 'network' | 'schedule';

// Naukri automation is parked ("in progress") — it stays visible on Connections but gets
// no run buttons here until it ships.
const PORTALS = ['linkedin', 'indeed'];
// Vector icon name + accent colour per event type (rendered via <Icon>).
const EVENT_ICON: Record<string, { name: string; color: string }> = {
  post_analysed: { name: 'search', color: '#60a5fa' },
  job_identified: { name: 'target', color: '#818cf8' },
  relevant: { name: 'sparkles', color: '#fbbf24' },
  applied: { name: 'send', color: '#34d399' },
  easy_apply: { name: 'bolt', color: '#818cf8' },
  connection_sent: { name: 'link', color: '#60a5fa' },
  message_sent: { name: 'send', color: '#a78bfa' },
  email_sent: { name: 'mail', color: '#34d399' },
  reply_received: { name: 'mail', color: '#2dd4bf' },
  error: { name: 'alert', color: '#f87171' },
  info: { name: 'circle', color: '#7d8595' },
};

// Theme-aware tones (see .tone-* in styles.css) — legible in light AND dark.
function Chip({ text, tone = 'indigo' }: { text: string; tone?: string }) {
  return <span className={`tone tone-${tone}`}>{text}</span>;
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
    try { await api.agentStartRun(portal); toast(`${portal} run queued — JobPilot Desktop will pick it up.`, 'success'); loadStatus(); }
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
              ? <Chip text={`${run?.portal} ${run?.status}`} tone="green" />
              : status.paused ? <Chip text="paused" tone="amber" /> : <Chip text="idle" tone="slate" />)}
            {status && !status.workerConfigured && <> <Chip text="desktop not connected" tone="red" /></>}
          </h1>
          <div className="page-sub">
            <b>The hands.</b> JobPilot Desktop drives a real browser on your PC and clicks through
            portals (LinkedIn / Indeed) with your own logged-in sessions — Easy Apply, connections,
            messages — while you watch live. The <b>Engine</b> is the brain that finds &amp; ranks jobs
            and writes your documents; this page is where those applications physically happen.
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" onClick={() => start('all')} disabled={busy || !status?.workerConfigured}
            title={status?.workerConfigured ? 'Run Naukri → LinkedIn → Indeed in sequence' : 'Set up JobPilot Desktop first'}>
            <Icon name="play" size={13} /> Run all
          </button>
          {PORTALS.map((p) => (
            <button key={p} className="btn btn-sm" onClick={() => start(p)} disabled={busy || !status?.workerConfigured}
              title={status?.workerConfigured ? `Queue a ${p} run` : 'Set up JobPilot Desktop first'}>
              <Icon name="play" size={13} /> {p}
            </button>
          ))}
          <button className={`btn btn-sm ${status?.paused ? '' : 'btn-danger-solid'}`} onClick={pause} disabled={busy || !status}>
            <Icon name={status?.paused ? 'play' : 'pause'} size={13} /> {status?.paused ? 'Resume' : 'Pause'}
          </button>
          {live && <button className="btn btn-sm" onClick={stop} disabled={busy}><Icon name="x" size={13} /> Stop</button>}
        </div>
      </div>

      {status && !status.workerConfigured && (
        <div className="card card-pad" style={{ marginBottom: 14, borderColor: 'var(--amber)', fontSize: 13, display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
          <Icon name="alert" size={16} className="t-amber" style={{ flex: 'none' }} />
          <span>JobPilot Desktop isn't connected yet — set it up once on the Connections page.</span>
          <a className="btn btn-sm" style={{ marginLeft: 'auto' }} href="/connections">Open Connections <Icon name="external" size={12} /></a>
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
        {([['live', 'live', 'Watch Live'], ['metrics', 'chart', 'Metrics'], ['flows', 'bolt', 'Automations'],
           ['activity', 'clipboard', 'Activity'],
           ['network', 'user', `Network${status?.pendingApprovals ? ` (${status.pendingApprovals})` : ''}`],
           ['schedule', 'clock', 'Schedule']] as [Tab, string, string][]).map(([t, ico, label]) => (
          <button key={t} className={`btn btn-sm ${tab === t ? 'btn-primary' : ''}`} onClick={() => setTab(t)}>
            <Icon name={ico} size={13} /> {label}
          </button>
        ))}
      </div>

      {tab === 'live' && <LiveTab run={run} live={live} />}
      {tab === 'metrics' && <MetricsTab />}
      {tab === 'flows' && <FlowsTab onRun={start} busy={busy} workerReady={status?.workerConfigured ?? false} />}
      {tab === 'activity' && <ActivityTab />}
      {tab === 'network' && <NetworkTab onChange={loadStatus} />}
      {tab === 'schedule' && <ScheduleTab />}
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
              <div style={{ marginBottom: 8, opacity: .5 }}><Icon name="live" size={40} /></div>
              Waiting for JobPilot Desktop's screen feed.<br />Start it and queue a run.
            </div>
          )}
        </div>
      </div>
      {run && (
        <div className="card card-pad row" style={{ gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
          <span className="run-stat"><Icon name="search" size={14} /> searched <b>{run.searched}</b></span>
          <span className="run-stat"><Icon name="sparkles" size={14} /> relevant <b>{run.evaluated}</b></span>
          <span className="run-stat"><Icon name="send" size={14} /> applied <b>{run.applied}</b></span>
          <span className="run-stat"><Icon name="link" size={14} /> connected <b>{run.connected}</b></span>
          <span className="run-stat"><Icon name="mail" size={14} /> messaged <b>{run.messaged}</b></span>
          <span className="run-stat"><Icon name="alert" size={14} /> failed <b>{run.failed}</b></span>
        </div>
      )}
    </div>
  );
}

// ---- Metrics: per-portal breakdown (LinkedIn vs Indeed, separately) --------

/**
 * The owner's transparency view: for EACH portal — what was found, applied, emailed,
 * connected, what failed, and (front and centre) the MANUAL list: matches the automation
 * couldn't auto-apply to. Derived from the last ~300 events.
 */
function MetricsTab() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  useEffect(() => {
    const pull = () => api.agentEvents(300).then(setEvents).catch(() => {});
    pull();
    const t = setInterval(pull, 8000);
    return () => clearInterval(t);
  }, []);

  const portalBlock = (portal: 'linkedin' | 'indeed') => {
    const ev = events.filter((e) => e.portal === portal);
    const n = (t: string) => ev.filter((e) => e.type === t).length;
    const applied = n('applied') + n('easy_apply');
    const manual = ev.filter((e) => e.type === 'manual_apply');
    const counts: [string, number, string][] = portal === 'linkedin'
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
          <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>· last {events.length ? '300 events' : '—'}</span>
        </div>
        <div className="metric-row">
          {counts.map(([label, v, tone]) => (
            <div key={label} className="metric-cell">
              <span className={`tone tone-${tone}`} style={{ fontSize: 15, fontWeight: 750, padding: '4px 12px' }}>{v}</span>
              <span className="faint" style={{ fontSize: 11.5 }}>{label}</span>
            </div>
          ))}
        </div>

        {manual.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="kv-k" style={{ marginBottom: 8 }}>Apply manually — the automation couldn't ({manual.length})</div>
            {manual.slice(0, 8).map((e) => (
              <div key={e.id} className="row" style={{ gap: 8, padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
                <Icon name="alert" size={13} className="t-amber" style={{ flex: 'none' }} />
                <a href={e.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>
                  {e.title || 'Job'}{e.company ? ` — ${e.company}` : ''}
                </a>
                <span className="faint" style={{ fontSize: 11.5, flex: 'none' }}>{fmtDate(e.createdAt)}</span>
              </div>
            ))}
            <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>You also get these by email every evening (21:45 IST).</div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {portalBlock('linkedin')}
      {portalBlock('indeed')}
    </div>
  );
}

// ---- Automations: the two flow types, per portal ----------------------------

/**
 * The daily automation, made explicit. Two kinds of work:
 *  1. OUTREACH  — connections, messages, HR emails (LinkedIn).
 *  2. AUTO APPLY — Easy Apply / Indeed Apply with the screening-answer bank.
 * Each portal card spells out its pipeline; toggles are the same master switches as the
 * Connections board (/api/agent/flows).
 */
function FlowsTab({ onRun, busy, workerReady }: { onRun: (p: string) => void; busy: boolean; workerReady: boolean }) {
  const toast = useToast();
  const [flows, setFlows] = useState<Record<string, boolean>>({});
  const [pendingQs, setPendingQs] = useState(0);
  const [template, setTemplate] = useState('');
  const [savingTpl, setSavingTpl] = useState(false);

  useEffect(() => {
    api.agentFlows().then(setFlows).catch(() => {});
    api.agentMessageTemplate().then((r) => setTemplate(r.template)).catch(() => {});
    api.qaList().then((l) => setPendingQs(l.filter((q) => !(q.answer && q.answer.trim())).length)).catch(() => {});
  }, []);

  const saveTemplate = async () => {
    setSavingTpl(true);
    try { await api.agentSetMessageTemplate(template); toast('Message template saved — connection notes now send automatically with it.', 'success'); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setSavingTpl(false); }
  };

  const toggle = async (key: string) => {
    const next = !flows[key];
    setFlows((f) => ({ ...f, [key]: next }));
    try { setFlows(await api.agentSetFlows({ [key]: next })); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const Row = ({ ico, children }: { ico: string; children: React.ReactNode }) => (
    <div className="flow-step"><Icon name={ico} size={14} /><span>{children}</span></div>
  );
  const Toggle = ({ k, label }: { k: string; label: string }) => (
    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
      <button role="switch" aria-checked={!!flows[k]} aria-label={label}
        className={`switch ${flows[k] ? 'on' : ''}`} onClick={() => toggle(k)}><span className="knob" /></button>
      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
    </div>
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
      {/* LinkedIn — outreach + easy apply */}
      <div className="card card-pad">
        <div className="card-title"><Icon name="link" size={15} /> LinkedIn — daily outreach &amp; Easy Apply</div>
        <Row ico="search">Search posts &amp; jobs for your keywords</Row>
        <Row ico="bolt">Easy Apply where available</Row>
        <Row ico="bookmark">No Easy Apply → saved for <b>manual apply</b> (Activity feed)</Row>
        <Row ico="mail">HR email found → auto-email with the job-tailored resume</Row>
        <Row ico="user">Connection requests + messages to recruiters</Row>
        <div className="row" style={{ gap: 14, marginTop: 12, flexWrap: 'wrap' }}>
          <Toggle k="autoEasyApply" label="Easy Apply" />
          <Toggle k="autoEmail" label="Auto-email" />
          <Toggle k="autoMessage" label="Auto-message" />
        </div>
        <button className="btn btn-primary btn-sm" style={{ marginTop: 14 }} disabled={busy || !workerReady}
          onClick={() => onRun('linkedin')} title={workerReady ? '' : 'Set up JobPilot Desktop first'}>
          <Icon name="play" size={13} /> Run LinkedIn now
        </button>
      </div>

      {/* Indeed — auto apply + question bank */}
      <div className="card card-pad">
        <div className="card-title"><Icon name="target" size={15} /> Indeed — daily Auto Apply</div>
        <Row ico="search">Search jobs for your keywords &amp; locations</Row>
        <Row ico="scale">Relevance check against your profile</Row>
        <Row ico="bolt">Indeed Apply on your logged-in session</Row>
        <Row ico="gap">Unknown screening questions are <b>saved for you to answer once</b> — after that they autofill forever</Row>
        <a className={`btn btn-sm ${pendingQs > 0 ? '' : 'btn-ghost'}`} style={{ marginTop: 12 }} href="/profile">
          <Icon name="pen" size={13} /> Answer bank
          {pendingQs > 0 && <span className="tone tone-amber">{pendingQs} waiting</span>}
        </a>
        <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} disabled={busy || !workerReady}
          onClick={() => onRun('indeed')} title={workerReady ? '' : 'Set up JobPilot Desktop first'}>
          <Icon name="play" size={13} /> Run Indeed now
        </button>
      </div>

      {/* Connection-message template — with this saved + Auto-message ON, notes send
          themselves; replies to recruiters always stay draft-first. */}
      <div className="card card-pad">
        <div className="card-title"><Icon name="send" size={15} /> Connection message template</div>
        <div className="faint" style={{ fontSize: 12.5, marginTop: -4, marginBottom: 8 }}>
          Sent automatically with connection requests when <b>Auto-message</b> is on.
          Placeholders: <code>[Name]</code> <code>[Role]</code> <code>[Company]</code> <code>[MyName]</code> <code>[MyRole]</code>.
          Replies to recruiters still wait for your approval.
        </div>
        <textarea className="input" rows={4} value={template} onChange={(e) => setTemplate(e.target.value)}
          placeholder={"Hi [Name], I'm [MyName], a [MyRole]. I'm actively looking for [Role] opportunities and would love to connect regarding openings at [Company]."} />
        <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={saveTemplate} disabled={savingTpl}>
          {savingTpl ? <span className="spinner" /> : <Icon name="check" size={13} />} Save template
        </button>
      </div>

      {/* Naukri — parked */}
      <div className="card card-pad" style={{ opacity: .85 }}>
        <div className="card-title"><Icon name="clock" size={15} /> Naukri — in progress</div>
        <div className="conn-note">
          Naukri automation is being built. The portal stays visible on Connections but no
          automated actions run against it yet.
        </div>
      </div>
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

  if (events.length === 0) return <div className="card card-pad empty"><div className="big"><Icon name="clipboard" size={34} /></div>No activity yet.</div>;
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {events.map((e) => (
        <div key={e.id} className="row card-pad" style={{ gap: 10, alignItems: 'flex-start', borderBottom: '1px solid var(--border,#1f2530)' }}>
          {(() => { const ei = EVENT_ICON[e.type] ?? EVENT_ICON.info;
            return <span className="ev-ico" style={{ color: ei.color, background: ei.color + '1f' }}><Icon name={ei.name} size={15} /></span>; })()}
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
        <h3 style={{ margin: '0 0 8px' }}>Approvals {pending.length > 0 && <Chip text={`${pending.length} waiting`} tone="amber" />}</h3>
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
              <button className="btn btn-primary btn-sm" onClick={() => approve(mm)}><Icon name="check" size={13} /> Approve</button>
              <button className="btn btn-ghost btn-sm" onClick={() => reject(mm)}><Icon name="x" size={13} /> Reject</button>
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
            <Chip text={c.connectionStatus} tone={c.connectionStatus === 'replied' ? 'green' : c.connectionStatus === 'connected' ? 'blue' : c.connectionStatus === 'pending' ? 'amber' : 'slate'} />
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
  const usePreset = async () => {
    if (!window.confirm('Replace your schedule with the recommended plan? (Easy Apply 2×/day per portal + one long evening outreach slot)')) return;
    try { setBlocks(await api.agentSchedulePreset()); toast('Recommended plan applied', 'success'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div className="card card-pad">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h3 style={{ margin: 0 }}>Daily rotation</h3>
          <p className="faint" style={{ fontSize: 13, margin: '4px 0 12px' }}>
            <b>Apply</b> blocks run Easy Apply only; the <b>Outreach</b> block scans posts, harvests
            HR emails and sends connections — give it the most time. Blank keywords/locations = from your profile.
          </p>
        </div>
        <button className="btn btn-sm" onClick={usePreset}><Icon name="sparkles" size={13} /> Use recommended plan</button>
      </div>
      {blocks.map((b, i) => (
        <div key={i} className="card card-pad" style={{ marginBottom: 8, background: 'var(--bg-elev)' }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <b style={{ textTransform: 'capitalize', minWidth: 72 }}>{b.portal}</b>
            <label style={{ fontSize: 12 }}>Mode
              <select className="select" style={{ width: 110 }} value={b.mode ?? 'apply'}
                onChange={(e) => upd(i, { mode: e.target.value })}>
                <option value="apply">Apply</option>
                <option value="outreach">Outreach</option>
              </select></label>
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
