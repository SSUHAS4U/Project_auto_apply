import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AgentEvent, AgentStatus } from '../types';
import { fmtDate, StatIcon } from '../lib/ui';
import { Icon } from '../components/Icon';
import { Select } from '../components/Select';
import { ActivityChart } from '../components/ActivityChart';
import { sinceFor, countJobs, type Period } from '../lib/metrics';

/**
 * Dashboard — the landing page. One glance at what the automation did today: status, the
 * eight metric tiles, an activity-trend chart (hand-rolled SVG, no deps), and the
 * recent-actions feed. Reads the agent brain (/api/agent) + engine (/api/engine).
 */

const EVENT_LABEL: Record<string, string> = {
  post_analysed: 'Post analysed', job_identified: 'Job identified', relevant: 'Relevant match',
  applied: 'Applied', easy_apply: 'Easy Apply', connection_sent: 'Connection sent',
  message_sent: 'Message sent', email_sent: 'Email sent', reply_received: 'Reply received',
  error: 'Issue', info: 'Update',
};
// Status chip per event type (HireDue-style "SUCCESS / PENDING" markers on tile recents).
const EVENT_STATUS: Record<string, { label: string; tone: string }> = {
  applied: { label: 'success', tone: 'green' }, easy_apply: { label: 'success', tone: 'green' },
  email_sent: { label: 'sent', tone: 'green' }, message_sent: { label: 'sent', tone: 'purple' },
  connection_sent: { label: 'pending', tone: 'blue' }, reply_received: { label: 'reply', tone: 'green' },
  relevant: { label: 'relevant', tone: 'amber' }, job_identified: { label: 'new', tone: 'indigo' },
  post_analysed: { label: 'scanned', tone: 'slate' }, error: { label: 'issue', tone: 'red' },
};

const PERIODS: { key: string; label: string }[] = [
  { key: 'total', label: 'All time' }, { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' }, { key: 'month', label: 'This month' },
];

export function DashboardPage() {
  const nav = useNavigate();
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [period, setPeriod] = useState<Period>('total');   // default: everything so far

  useEffect(() => {
    const pull = () => {
      api.agentStatus().then(setAgent).catch(() => {});
      // Everything is computed from ONE events list (deduped, client-side) so the cards and the
      // chart can never disagree. Pull enough to cover the range.
      api.agentEvents(2000).then(setEvents).catch(() => {});
    };
    pull();
    const t = setInterval(pull, 6000);
    return () => clearInterval(t);
  }, []);

  const running = !!agent?.activeRun && ['running', 'queued', 'needs_attention'].includes(agent.activeRun.status);

  // The ONE filter — the dropdown — scopes both the cards and the chart to the same window.
  const since = sinceFor(period);
  const scoped = useMemo(
    () => events.filter((e) => e.createdAt && new Date(e.createdAt).getTime() >= since),
    [events, since]);
  // Period → the chart's x-axis granularity (today: hourly, week/month: daily, all: monthly).
  const chartRange = ({ today: 'day', week: 'week', month: 'month', total: 'year' } as const)[period];

  // Each card counts DISTINCT JOBS over the scoped window — same helper the chart uses, so
  // "Jobs identified" here equals what the chart sums. (Was raw event counts → 100 jobs read
  // as 710 because the same job appears in every city search.)
  const tiles = [
    { key: 'posts', label: 'Posts analysed', types: ['post_analysed'], color: '#5b5bd6' },
    { key: 'target', label: 'Jobs identified', types: ['job_identified'], color: '#2563eb' },
    { key: 'star', label: 'Relevant jobs', types: ['relevant'], color: '#d97706' },
    { key: 'send', label: 'Applied', types: ['applied', 'easy_apply'], color: '#16a34a' },
    { key: 'link', label: 'Connections sent', types: ['connection_sent'], color: '#7c3aed' },
    { key: 'chat', label: 'Messages sent', types: ['message_sent'], color: '#0891b2' },
    { key: 'mail', label: 'Emails sent', types: ['email_sent'], color: '#db2777' },
    { key: 'reply', label: 'Replies received', types: ['reply_received'], color: '#16a34a' },
  ].map((t) => ({ ...t, value: countJobs(scoped, t.types) }));

  // Recent action per metric type (scoped), for the mini-lists on each tile.
  const recentByType = useMemo(() => {
    const map: Record<string, AgentEvent[]> = {};
    for (const e of scoped) (map[e.type] ??= []).push(e);
    return map;
  }, [scoped]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-sub">Everything your automation has done, at a glance.</div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`tone ${running ? 'tone-green live-pulse' : 'tone-slate'}`} style={{ padding: '5px 12px' }}>
            <span className="live-dot" /> {running ? `${agent?.activeRun?.portal} · scanning & applying` : 'idle'}
          </span>
          <Select value={period} onChange={(v) => setPeriod(v as Period)} ariaLabel="Metrics period"
            options={PERIODS.map((p) => ({ value: p.key, label: p.label }))} />
        </div>
      </div>

      {/* Activity trend — same period + same data as the cards */}
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
          <div><b style={{ fontSize: 15 }}>Activity trend</b></div>
          <div className="faint" style={{ fontSize: 12.5 }}>tap a series to hide it</div>
        </div>
        <ActivityChart events={scoped} range={chartRange} />
      </div>

      {/* Metric tiles */}
      <div className="dash-tiles">
        {tiles.map((t) => {
          const recent = (recentByType[t.key === 'posts' ? 'post_analysed'
            : t.key === 'target' ? 'job_identified' : t.key === 'star' ? 'relevant'
            : t.key === 'send' ? 'applied' : t.key === 'link' ? 'connection_sent'
            : t.key === 'chat' ? 'message_sent' : t.key === 'mail' ? 'email_sent' : 'reply_received'] ?? [])
            .concat(t.key === 'send' ? (recentByType['easy_apply'] ?? []) : []);
          return (
            <div key={t.key} className="card card-pad">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div className="faint" style={{ fontSize: 11.5, letterSpacing: '.04em', textTransform: 'uppercase' }}>{t.label}</div>
                  <div data-tilevalue style={{ fontWeight: 750, marginTop: 4, letterSpacing: '-.02em', lineHeight: 1 }}>{t.value}</div>
                </div>
                <StatIcon name={t.key} color={t.color} />
              </div>
              <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <div className="faint" style={{ fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 4 }}>Recent</div>
                {recent.slice(0, 2).map((e) => (
                  <div key={e.id} className="row" style={{ fontSize: 12.5, gap: 8, flexWrap: 'nowrap', padding: '2px 0' }}>
                    <span style={{ fontWeight: 600, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {e.title || EVENT_LABEL[e.type]}
                      {e.company && <span className="faint" style={{ fontWeight: 400 }}> · {e.company}</span>}
                    </span>
                    {EVENT_STATUS[e.type] && (
                      <span className={`tone tone-${EVENT_STATUS[e.type].tone}`} style={{ flex: 'none', textTransform: 'uppercase', fontSize: 10 }}>
                        {EVENT_STATUS[e.type].label}
                      </span>
                    )}
                  </div>
                ))}
                {recent.length === 0 && <div className="faint" style={{ fontSize: 12.5 }}>—</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent actions + engine snapshot */}
      <div className="dash-cols">
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-pad" style={{ borderBottom: '1px solid var(--border)', fontWeight: 700 }}>Recent actions</div>
          {events.length === 0 ? (
            <div className="card-pad faint" style={{ fontSize: 13 }}>No activity yet — connect LinkedIn/Indeed and run the automation.</div>
          ) : events.slice(0, 12).map((e) => (
            <div key={e.id} className="row card-pad" style={{ gap: 10, alignItems: 'center', borderBottom: '1px solid var(--border)', padding: '10px 16px' }}>
              <span className="chip" style={{ fontSize: 11 }}>{EVENT_LABEL[e.type] ?? e.type}</span>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {e.title ? <a href={e.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>{e.title}</a> : (e.detail || '—')}
                {e.company && <span className="faint"> · {e.company}</span>}
              </div>
              <span className="faint" style={{ fontSize: 11.5, flexShrink: 0 }}>{fmtDate(e.createdAt)}</span>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card card-pad">
            <div className="card-title"><Icon name="compass" size={15} /> Job board</div>
            <div className="faint" style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 4 }}>
              Fresh jobs aggregated from company boards &amp; APIs — browse, filter, and apply yourself
              (email-apply or open the posting).
            </div>
            <button className="btn btn-sm" style={{ marginTop: 10, width: '100%' }} onClick={() => nav('/jobs')}>Open Job board <Icon name="external" size={13} /></button>
          </div>

          <div className="card card-pad">
            <div className="card-title"><Icon name="live" size={15} /> Automation</div>
            <Row label="Desktop worker" value={agent?.workerConfigured ? 'connected' : 'not connected'} tone={agent?.workerConfigured ? 'green' : 'slate'} />
            <Row label="Active run" value={running ? (agent?.activeRun?.portal ?? 'running') : 'idle'} tone={running ? 'blue' : undefined} />
            <Row label="Pending approvals" value={String(agent?.pendingApprovals ?? 0)} last />
            <button className="btn btn-sm" style={{ marginTop: 12, width: '100%' }} onClick={() => nav('/auto-apply')}>Open Auto Apply <Icon name="external" size={13} /></button>
          </div>

          <div className="card card-pad">
            <div className="card-title"><Icon name="compass" size={15} /> Quick actions</div>
            <div className="quick-grid">
              <button className="quick-btn" onClick={() => nav('/connections')}><Icon name="link" size={16} /><span>Connect portals</span></button>
              <button className="quick-btn" onClick={() => nav('/profile')}><Icon name="user" size={16} /><span>Edit profile</span></button>
              <button className="quick-btn" onClick={() => nav('/resumes')}><Icon name="file" size={16} /><span>Resumes</span></button>
              <button className="quick-btn" onClick={() => nav('/jobs')}><Icon name="compass" size={16} /><span>Browse jobs</span></button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Row({ label, value, tone, last }: { label: string; value: string; tone?: string; last?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', padding: '7px 0', fontSize: 13.5, borderBottom: last ? 'none' : '1px solid var(--border)' }}>
      <span className="faint">{label}</span>
      {tone ? <span className={`tone tone-${tone}`}>{value}</span> : <b>{value}</b>}
    </div>
  );
}
