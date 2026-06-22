import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { Application, ApplicationEvent, ApplicationStatus } from '../types';
import { ApplyBadge, ScoreBar, fmtDate, useToast } from '../lib/ui';
import { Modal } from '../components/Modal';

const STATUSES: ApplicationStatus[] = ['interested', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn'];

export function ApplicationsPage() {
  const toast = useToast();
  const [apps, setApps] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Application | null>(null);
  const [filter, setFilterState] = useState<ApplicationStatus | 'all'>(
    () => (localStorage.getItem('jobpilot_app_filter') as ApplicationStatus | 'all') || 'all');
  const setFilter = (f: ApplicationStatus | 'all') => { localStorage.setItem('jobpilot_app_filter', f); setFilterState(f); };

  const load = () => {
    setLoading(true);
    api.applications().then(setApps).catch((e) => toast(e.message, 'error')).finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line

  const move = async (a: Application, status: ApplicationStatus) => {
    try {
      await api.updateApplication(a.id, { status });
      setApps((xs) => xs.map((x) => (x.id === a.id ? { ...x, status } : x)));
      toast(`Moved to ${status}`, 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: apps.length };
    apps.forEach((a) => { c[a.status] = (c[a.status] ?? 0) + 1; });
    return c;
  }, [apps]);

  const rows = filter === 'all' ? apps : apps.filter((a) => a.status === filter);
  const title = (a: Application) => a.job?.title ?? (a.jobId ? 'Linked job' : 'Manual entry');

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Applications</h1>
          <div className="page-sub">{apps.length} tracked · {counts['applied'] ?? 0} applied · {counts['interviewing'] ?? 0} interviewing · {counts['offer'] ?? 0} offers</div>
        </div>
      </div>

      <div className="stat-grid">
        <div className="card stat"><div className="stat-label">Tracked</div><div className="stat-value">{apps.length}</div></div>
        <div className="card stat"><div className="stat-label">Applied</div><div className="stat-value accent">{counts['applied'] ?? 0}</div></div>
        <div className="card stat"><div className="stat-label">Interviewing</div><div className="stat-value" style={{ color: 'var(--amber)' }}>{counts['interviewing'] ?? 0}</div></div>
        <div className="card stat"><div className="stat-label">Offers</div><div className="stat-value" style={{ color: 'var(--green)' }}>{counts['offer'] ?? 0}</div></div>
      </div>

      <div className="tabs">
        {(['all', ...STATUSES] as const).map((s) => (
          <div key={s} className={`tab ${filter === s ? 'active' : ''}`} onClick={() => setFilter(s)}>
            {s === 'all' ? 'All' : s} <span className="faint">{counts[s] ?? 0}</span>
          </div>
        ))}
      </div>

      {loading ? <div className="empty"><span className="spinner" /></div>
        : rows.length === 0 ? (
          <div className="card card-pad empty"><div className="big">📋</div>No applications in this view. Track a job from the Jobs or Daily picks page.</div>
        ) : (
          <>
            {/* Desktop: table */}
            <div className="table-wrap only-desktop">
              <table>
                <thead>
                  <tr>
                    <th>Role</th><th>Location</th><th>Match</th><th>Apply</th>
                    <th>Status</th><th>Method</th><th>Applied</th><th>Updated</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div className="job-title" style={{ cursor: 'pointer' }} onClick={() => setSelected(a)}>{title(a)}</div>
                        <div className="job-company">{a.job?.company ?? '—'}{a.job?.remote ? ' · Remote' : ''}</div>
                      </td>
                      <td className="muted">{a.job?.location ?? '—'}</td>
                      <td>{typeof a.job?.matchScore === 'number' ? <ScoreBar score={a.job.matchScore} /> : <span className="faint">—</span>}</td>
                      <td>{a.job?.applyType ? <ApplyBadge type={a.job.applyType} /> : <span className="faint">—</span>}</td>
                      <td>
                        <select className="status-pill" value={a.status} onClick={(e) => e.stopPropagation()}
                          onChange={(e) => move(a, e.target.value as ApplicationStatus)}>
                          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                      <td className="muted">{a.method ?? '—'}</td>
                      <td className="muted">{a.appliedAt ? fmtDate(a.appliedAt) : '—'}</td>
                      <td className="muted">{fmtDate(a.updatedAt)}</td>
                      <td>
                        <div className="cell-actions">
                          <button className="btn btn-sm" onClick={() => setSelected(a)}>Details</button>
                          {a.job?.url && <a className="btn btn-ghost btn-sm" href={a.job.url} target="_blank" rel="noreferrer">↗</a>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: cards */}
            <div className="only-mobile" style={{ gap: 12 }}>
              {rows.map((a) => (
                <div key={a.id} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="job-title" onClick={() => setSelected(a)} style={{ cursor: 'pointer' }}>{title(a)}</div>
                      <div className="job-company">{a.job?.company ?? '—'}{a.job?.remote ? ' · Remote' : ''}</div>
                    </div>
                    {typeof a.job?.matchScore === 'number' && <span className="chip">{a.job.matchScore}</span>}
                  </div>
                  <div className="row" style={{ gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--muted)' }}>
                    {a.job?.location && <span>📍 {a.job.location}</span>}
                    {a.job?.applyType && <ApplyBadge type={a.job.applyType} />}
                    {a.appliedAt && <span>✉ {fmtDate(a.appliedAt)}</span>}
                    <span>↻ {fmtDate(a.updatedAt)}</span>
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <select className="status-pill" value={a.status} onChange={(e) => move(a, e.target.value as ApplicationStatus)}>
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <button className="btn btn-sm" onClick={() => setSelected(a)}>Details</button>
                    {a.job?.url && <a className="btn btn-ghost btn-sm" href={a.job.url} target="_blank" rel="noreferrer">↗ Open</a>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

      {selected && <ApplicationModal app={selected} onClose={() => setSelected(null)} onChanged={load} />}
    </>
  );
}

function ApplicationModal({ app, onClose, onChanged }: { app: Application; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [events, setEvents] = useState<ApplicationEvent[]>([]);
  const [notes, setNotes] = useState(app.notes ?? '');
  const [status, setStatus] = useState<ApplicationStatus>(app.status);

  useEffect(() => { api.timeline(app.id).then(setEvents).catch(() => {}); }, [app.id]);

  const save = async () => {
    try {
      await api.updateApplication(app.id, { status, notes });
      toast('Saved', 'success'); onChanged(); onClose();
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const j = app.job;
  return (
    <Modal title={j?.title ?? 'Application'} onClose={onClose} wide
      footer={<><button className="btn btn-ghost" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={save}>Save</button></>}>
      {j && (
        <dl className="detail-grid">
          <dt>Company</dt><dd>{j.company ?? '—'}</dd>
          <dt>Location</dt><dd>{j.location ?? (j.remote ? 'Remote' : '—')}</dd>
          <dt>Apply type</dt><dd>{j.applyType ?? '—'}{j.applyEmail ? ` · ${j.applyEmail}` : ''}</dd>
          <dt>Match score</dt><dd>{typeof j.matchScore === 'number' ? j.matchScore : '—'}</dd>
          {j.url && <><dt>Posting</dt><dd><a href={j.url} target="_blank" rel="noreferrer">Open ↗</a></dd></>}
          <dt>Method</dt><dd>{app.method ?? '—'}</dd>
          <dt>Applied at</dt><dd>{app.appliedAt ? fmtDate(app.appliedAt) : '—'}</dd>
          <dt>Created</dt><dd>{fmtDate(app.createdAt)}</dd>
        </dl>
      )}
      <label className="field">Status
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value as ApplicationStatus)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="field">Notes<textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      {app.coverLetter && <label className="field">Cover letter sent<div className="pre">{app.coverLetter}</div></label>}
      <div>
        <div className="muted" style={{ marginBottom: 8 }}>Timeline</div>
        <div className="tl">
          {events.length === 0 && <div className="faint">No events yet.</div>}
          {events.map((e) => (
            <div className="tl-item" key={e.id}>
              <div><b>{e.eventType}</b> {e.detail && <span className="muted">{e.detail}</span>}</div>
              <div className="tl-time">{fmtDate(e.createdAt)}</div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
