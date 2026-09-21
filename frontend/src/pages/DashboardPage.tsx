import { useEffect, useMemo, useState } from 'react';
import { startPoll } from '../lib/poll';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AgentEvent, AgentStatus } from '../types';
import { fmtDate } from '../lib/ui';
import { Icon } from '../components/Icon';
import { Select } from '../components/Select';
import { ActivityChart } from '../components/ActivityChart';
import { sinceFor, countJobs, type Period } from '../lib/metrics';

/**
 * Dashboard — the first screen after sign-in. Read top to bottom it answers, in order:
 *   1. how is the search going?          → four headline numbers in ONE strip
 *   2. what else did the automation do?  → the outreach counts, smaller
 *   3. is it trending up?                → the activity chart, beside the pipeline funnel
 *   4. does anything need me?            → "Needs you", built only from real status signals
 *   5. what just happened?               → recent activity
 *
 * Everything is computed from ONE events list (deduped, client-side, via lib/metrics) so the
 * numbers, the funnel and the chart can never disagree.
 */

const EVENT_LABEL: Record<string, string> = {
  post_analysed: 'Post analysed', job_identified: 'Job identified', relevant: 'Relevant match',
  applied: 'Applied', easy_apply: 'Easy Apply', connection_sent: 'Connection sent',
  message_sent: 'Message sent', email_sent: 'Email sent', reply_received: 'Reply received',
  error: 'Issue', info: 'Update',
};
/**
 * Colour here is SEMANTIC, not categorical (docs/UI_SPEC.md): green = a good outcome, red = a
 * real problem, and every intermediate step of the pipeline is neutral — "sent" and "scanned"
 * are progress, not verdicts.
 */
const EVENT_TONE: Record<string, 'ok' | 'danger' | 'accent' | 'neutral'> = {
  applied: 'accent', easy_apply: 'accent', reply_received: 'ok', error: 'danger',
};

const PERIODS: { key: Period; label: string }[] = [
  { key: 'total', label: 'All time' }, { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' }, { key: 'month', label: 'This month' },
];

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** A share as "10.2%", or "—" when there is nothing to divide by — never "NaN%" or a fake 0%. */
function pct(part: number, whole: number): string {
  if (!whole) return '—';
  const v = (part / whole) * 100;
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)}%`;
}

type NeedTone = 'danger' | 'warn' | 'info';
interface Need { key: string; tone: NeedTone; ico: string; title: string; detail: string; action: string; to: string }

export function DashboardPage() {
  const nav = useNavigate();
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [period, setPeriod] = useState<Period>('total');   // default: everything so far

  useEffect(() => {
    api.me().then((u) => setFirstName((u.fullName || '').trim().split(/\s+/)[0] || '')).catch(() => {});
    const pull = () => {
      api.agentStatus().then(setAgent).catch(() => {});
      api.agentEvents(2000).then(setEvents).catch(() => {}).finally(() => setLoaded(true));
    };
    return startPoll(pull, 30000);
  }, []);

  const running = !!agent?.activeRun && ['running', 'queued', 'needs_attention'].includes(agent.activeRun.status);

  // The ONE filter — the period — scopes the numbers, the funnel and the chart to one window.
  const since = sinceFor(period);
  const scoped = useMemo(
    () => events.filter((e) => e.createdAt && new Date(e.createdAt).getTime() >= since),
    [events, since]);
  const chartRange = ({ today: 'day', week: 'week', month: 'month', total: 'year' } as const)[period];

  const n = (types: string[]) => countJobs(scoped, types);
  const posts = n(['post_analysed']);
  const identified = n(['job_identified']);
  const relevant = n(['relevant']);
  const applied = n(['applied', 'easy_apply']);
  const replies = n(['reply_received']);
  const outreach = [
    { label: 'Posts analysed', value: posts },
    { label: 'Connections sent', value: n(['connection_sent']) },
    { label: 'Messages sent', value: n(['message_sent']) },
    { label: 'Emails sent', value: n(['email_sent']) },
  ];

  // Funnel: each stage as a share of the widest one, so the bars compare honestly.
  const funnel = [
    { label: 'Identified', value: identified },
    { label: 'Relevant', value: relevant },
    { label: 'Applied', value: applied, hl: true },
    { label: 'Replied', value: replies },
  ];
  const funnelMax = Math.max(1, ...funnel.map((f) => f.value));

  // Built only from signals the server actually reports — nothing here is inferred.
  const needs: Need[] = [];
  if (agent) {
    if (!agent.workerConfigured) needs.push({ key: 'worker', tone: 'danger', ico: 'live', title: 'Desktop app not connected',
      detail: 'Auto apply runs in the desktop app. Install it and sign in to start.', action: 'Set up', to: '/auto-apply' });
    else if (!agent.workerOnline) needs.push({ key: 'offline', tone: 'warn', ico: 'live', title: 'Desktop app is offline',
      detail: 'Open the desktop app on your computer so scheduled runs can start.', action: 'Open', to: '/auto-apply' });
    if (agent.activeRun?.status === 'needs_attention') needs.push({ key: 'attn', tone: 'warn', ico: 'alert',
      title: 'A run is waiting on you', detail: `${agent.activeRun.portal ?? 'The run'} stopped at a step it can't finish alone.`, action: 'Review', to: '/auto-apply' });
    if (agent.pendingApprovals > 0) needs.push({ key: 'approvals', tone: 'info', ico: 'clipboard',
      title: `${agent.pendingApprovals} ${agent.pendingApprovals === 1 ? 'approval' : 'approvals'} waiting`,
      detail: 'Applications held for your OK before they are sent.', action: 'Review', to: '/auto-apply' });
    if (agent.paused) needs.push({ key: 'paused', tone: 'info', ico: 'pause', title: 'Auto apply is paused',
      detail: 'Nothing is sent until you resume it.', action: 'Resume', to: '/auto-apply' });
  }

  const statusText = running
    ? `Running on ${agent?.activeRun?.portal ?? 'a portal'}${agent?.liveAction ? ` · ${agent.liveAction}` : ''}`
    : events[0]?.createdAt ? `Idle · last activity ${fmtDate(events[0].createdAt)}` : 'Idle';

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="page-title">{greeting()}{firstName ? `, ${firstName}` : ''}</h1>
          <div className="page-sub dash-status">
            <span className={`dot ${running ? 'dot-live' : ''}`} aria-hidden="true" />{statusText}
          </div>
        </div>
        <div className="page-acts">
          <Select value={period} onChange={(v) => setPeriod(v as Period)} ariaLabel="Metrics period"
            options={PERIODS.map((p) => ({ value: p.key, label: p.label }))} />
          <button className="btn btn-primary" onClick={() => nav('/auto-apply')}>
            <Icon name="bolt" size={15} /> Auto apply
          </button>
        </div>
      </div>

      <section className="kpis" aria-label="Headline numbers">
        <Kpi label="Applied" value={applied} loaded={loaded} note={`${pct(applied, relevant)} of relevant jobs`} />
        <Kpi label="Replies" value={replies} loaded={loaded} note={`${pct(replies, applied)} reply rate`} />
        <Kpi label="Relevant jobs" value={relevant} loaded={loaded} note="matched your profile" />
        <Kpi label="Jobs identified" value={identified} loaded={loaded} note="across every source" />
      </section>

      <section className="kpis kpis-sm" aria-label="Outreach">
        {outreach.map((o) => <Kpi key={o.label} label={o.label} value={o.value} loaded={loaded} small />)}
      </section>

      <div className="dash-grid">
        <div className="card">
          <div className="card-head">
            <div><h3>Activity</h3><div className="card-sub">{PERIODS.find((p) => p.key === period)?.label} · tap a series to hide it</div></div>
          </div>
          <div className="card-body"><ActivityChart events={scoped} range={chartRange} /></div>
        </div>
        <div className="card">
          <div className="card-head"><div><h3>Pipeline</h3><div className="card-sub">From found to replied</div></div></div>
          <div className="funnel">
            {funnel.map((f, i) => (
              <div key={f.label} className={`fn ${f.hl ? 'hl' : ''}`}>
                <span className="fn-l">{f.label}</span>
                <span className="fn-bar"><i style={{ width: `${(f.value / funnelMax) * 100}%` }} /></span>
                <span className="fn-v">
                  {loaded ? f.value.toLocaleString() : '—'}
                  {i > 0 && <small>{pct(f.value, funnel[i - 1].value)}</small>}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="dash-grid dash-grid-even">
        <div className="card">
          <div className="card-head">
            <div><h3>Needs you</h3><div className="card-sub">Runs pause on these until you act</div></div>
            {needs.length > 0 && <span className="chip chip-warn">{needs.length}</span>}
          </div>
          {!agent ? (
            <div className="list-empty">Checking the automation…</div>
          ) : needs.length === 0 ? (
            <div className="list-empty"><Icon name="check" size={16} /> Nothing needs you. The automation has everything it needs.</div>
          ) : needs.map((x) => (
            <div key={x.key} className="list-row">
              <span className={`list-ico list-ico-${x.tone}`}><Icon name={x.ico} size={16} /></span>
              <div className="list-body"><div className="list-t">{x.title}</div><div className="list-s">{x.detail}</div></div>
              <button className="btn btn-sm" onClick={() => nav(x.to)}>{x.action}</button>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-head">
            <div><h3>Recent activity</h3></div>
            <button className="btn btn-ghost btn-sm" onClick={() => nav('/applications')}>Applications</button>
          </div>
          {!loaded ? (
            <div className="list-empty">Loading activity…</div>
          ) : events.length === 0 ? (
            <div className="list-empty">No activity yet. Connect LinkedIn or Indeed and run auto apply, and what it does shows up here.</div>
          ) : events.slice(0, 8).map((e) => (
            <div key={e.id} className="list-row">
              <span className={`chip chip-${EVENT_TONE[e.type] ?? 'neutral'}`}>{EVENT_LABEL[e.type] ?? e.type}</span>
              <div className="list-body">
                <div className="list-t">
                  {e.title ? <a href={e.url} target="_blank" rel="noreferrer">{e.title}</a> : (e.detail || '—')}
                </div>
                {e.company && <div className="list-s">{e.company}</div>}
              </div>
              <span className="list-when">{fmtDate(e.createdAt)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Kpi({ label, value, note, loaded, small }: { label: string; value: number; note?: string; loaded: boolean; small?: boolean }) {
  return (
    <div className="kpi">
      <div className="kpi-k">{label}</div>
      <div className={`kpi-v ${small ? 'kpi-v-sm' : ''}`}>{loaded ? value.toLocaleString() : '—'}</div>
      {note && <div className="kpi-d">{loaded ? note : ' '}</div>}
    </div>
  );
}
