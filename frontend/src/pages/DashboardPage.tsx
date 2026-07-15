import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AgentEvent, AgentStatus, EngineStatus } from '../types';
import { fmtDate, StatIcon } from '../lib/ui';

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

export function DashboardPage() {
  const nav = useNavigate();
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [engine, setEngine] = useState<EngineStatus | null>(null);

  useEffect(() => {
    const pull = () => {
      api.agentStatus().then(setAgent).catch(() => {});
      api.agentEvents(100).then(setEvents).catch(() => {});
      api.engineStatus().then(setEngine).catch(() => {});
    };
    pull();
    const t = setInterval(pull, 6000);
    return () => clearInterval(t);
  }, []);

  const m = agent?.metricsToday;
  const running = !!agent?.activeRun && ['running', 'queued', 'needs_attention'].includes(agent.activeRun.status);

  const tiles = [
    { key: 'posts', label: 'Posts analysed', value: m?.postsAnalysed ?? 0, color: '#5b5bd6' },
    { key: 'target', label: 'Jobs identified', value: m?.jobsIdentified ?? 0, color: '#2563eb' },
    { key: 'star', label: 'Relevant jobs', value: m?.relevantJobs ?? 0, color: '#d97706' },
    { key: 'send', label: 'Applied', value: m?.applied ?? 0, color: '#16a34a' },
    { key: 'link', label: 'Connections sent', value: m?.connectionsSent ?? 0, color: '#7c3aed' },
    { key: 'chat', label: 'Messages sent', value: m?.messagesSent ?? 0, color: '#0891b2' },
    { key: 'mail', label: 'Emails sent', value: m?.emailsSent ?? 0, color: '#db2777' },
    { key: 'reply', label: 'Replies received', value: m?.repliesReceived ?? 0, color: '#16a34a' },
  ];

  // Recent action per metric type, for the mini-lists on each tile.
  const recentByType = useMemo(() => {
    const map: Record<string, AgentEvent[]> = {};
    for (const e of events) (map[e.type] ??= []).push(e);
    return map;
  }, [events]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-sub">Everything your automation did today, at a glance.</div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="chip" style={{
            background: running ? '#16a34a18' : '#83849518', color: running ? '#16a34a' : '#838b98',
            borderColor: running ? '#16a34a44' : '#83849544', padding: '5px 11px', fontWeight: 600,
          }}>
            {running ? <>● {agent?.activeRun?.portal} · scanning &amp; applying</> : '○ idle'}
          </span>
          <button className="btn btn-primary btn-sm" onClick={() => nav('/agent')}>▶ Watch live</button>
        </div>
      </div>

      {/* Activity trend */}
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <div><b style={{ fontSize: 15 }}>Activity trend</b> <span className="faint" style={{ fontSize: 12.5 }}>· today, hourly</span></div>
          <div className="faint" style={{ fontSize: 12.5 }}>{events.length} events</div>
        </div>
        <ActivityChart events={events} />
      </div>

      {/* Metric tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12, marginBottom: 14 }}>
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
                  <div style={{ fontSize: 30, fontWeight: 750, marginTop: 2, letterSpacing: '-.02em' }}>{t.value}</div>
                </div>
                <StatIcon name={t.key} color={t.color} />
              </div>
              <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <div className="faint" style={{ fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 4 }}>Recent</div>
                {recent.slice(0, 2).map((e) => (
                  <div key={e.id} style={{ fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <span style={{ fontWeight: 600 }}>{e.title || EVENT_LABEL[e.type]}</span>
                    {e.company && <span className="faint"> · {e.company}</span>}
                  </div>
                ))}
                {recent.length === 0 && <div className="faint" style={{ fontSize: 12.5 }}>—</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent actions + engine snapshot */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 14 }}>
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-pad" style={{ borderBottom: '1px solid var(--border)', fontWeight: 700 }}>Recent actions</div>
          {events.length === 0 ? (
            <div className="card-pad faint" style={{ fontSize: 13 }}>No activity yet. Turn on the Agent or Auto Apply autopilot.</div>
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

        <div className="card card-pad">
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Auto Apply engine</div>
          <Row label="Autopilot" value={engine?.autopilot.enabled ? (engine.autopilot.running ? 'running' : 'on · daily') : 'off'} />
          <Row label="Backlog jobs" value={String(engine?.jobStatusCounts?.['new'] ?? 0)} />
          <Row label="Shortlisted" value={String(engine?.jobStatusCounts?.['shortlisted'] ?? 0)} />
          <Row label="Applications" value={String(Object.values(engine?.appStageCounts ?? {}).reduce((a, b) => a + b, 0))} />
          <button className="btn btn-sm" style={{ marginTop: 10, width: '100%' }} onClick={() => nav('/auto-apply')}>Open Auto Apply →</button>
          {engine?.autopilot.lastRunSummary && (
            <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Last run: {engine.autopilot.lastRunSummary}</div>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', padding: '5px 0', fontSize: 13.5, borderBottom: '1px solid var(--border)' }}>
      <span className="faint">{label}</span><b>{value}</b>
    </div>
  );
}

// ---- hand-rolled activity chart (SVG area+line; no chart library) -----------

function ActivityChart({ events }: { events: AgentEvent[] }) {
  const series = useMemo(() => {
    // bucket the last 14 hours by hour
    const now = new Date();
    const buckets: { h: number; label: string; n: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 3600_000);
      buckets.push({ h: d.getHours(), label: `${String(d.getHours()).padStart(2, '0')}:00`, n: 0 });
    }
    const startMs = now.getTime() - 14 * 3600_000;
    for (const e of events) {
      const t = new Date(e.createdAt).getTime();
      if (t < startMs) continue;
      const idx = 13 - Math.floor((now.getTime() - t) / 3600_000);
      if (idx >= 0 && idx < 14) buckets[idx].n++;
    }
    return buckets;
  }, [events]);

  const W = 900, H = 180, pad = 24;
  const max = Math.max(4, ...series.map((s) => s.n));
  const x = (i: number) => pad + (i * (W - 2 * pad)) / (series.length - 1);
  const y = (n: number) => H - pad - (n / max) * (H - 2 * pad);
  const pts = series.map((s, i) => `${x(i)},${y(s.n)}`).join(' ');
  const area = `${pad},${H - pad} ${pts} ${W - pad},${H - pad}`;
  const hasData = series.some((s) => s.n > 0);

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Activity trend, last 14 hours">
        <defs>
          <linearGradient id="actfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((g) => (
          <line key={g} x1={pad} x2={W - pad} y1={H - pad - g * (H - 2 * pad)} y2={H - pad - g * (H - 2 * pad)}
            stroke="var(--border)" strokeWidth="1" />
        ))}
        {hasData && <polygon points={area} fill="url(#actfill)" />}
        {hasData && <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
        {hasData && series.map((s, i) => s.n > 0 && (
          <circle key={i} cx={x(i)} cy={y(s.n)} r="3.2" fill="var(--accent)" />
        ))}
        {series.filter((_, i) => i % 2 === 0).map((s, i) => (
          <text key={i} x={x(i * 2)} y={H - 6} fontSize="10" fill="var(--text-faint)" textAnchor="middle">{s.label}</text>
        ))}
        {!hasData && <text x={W / 2} y={H / 2} fontSize="13" fill="var(--text-faint)" textAnchor="middle">No activity in the last 14 hours</text>}
      </svg>
    </div>
  );
}
