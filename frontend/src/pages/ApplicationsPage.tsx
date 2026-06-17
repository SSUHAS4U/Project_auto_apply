import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { Application, ApplicationEvent, ApplicationStatus } from '../types';
import { ApplyBadge, fmtDate, useToast } from '../lib/ui';
import { Modal } from '../components/Modal';

const STATUSES: ApplicationStatus[] = ['interested', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn'];
const NEXT: Record<ApplicationStatus, ApplicationStatus[]> = {
  interested: ['applied', 'rejected'],
  applied: ['interviewing', 'rejected'],
  interviewing: ['offer', 'rejected'],
  offer: ['applied', 'withdrawn'],
  rejected: ['interested'],
  withdrawn: ['interested'],
};

export function ApplicationsPage() {
  const toast = useToast();
  const [apps, setApps] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Application | null>(null);

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
    const c: Record<string, number> = {};
    apps.forEach((a) => { c[a.status] = (c[a.status] ?? 0) + 1; });
    return c;
  }, [apps]);

  const title = (a: Application) => a.job?.title ?? (a.jobId ? 'Linked job' : 'Manual entry');

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Applications</h1>
          <div className="page-sub">{apps.length} tracked · {counts['applied'] ?? 0} applied · {counts['interviewing'] ?? 0} interviewing · {counts['offer'] ?? 0} offers</div>
        </div>
      </div>

      {loading ? <div className="empty"><span className="spinner" /></div> : apps.length === 0 ? (
        <div className="card card-pad empty"><div className="big">📋</div>No applications yet. Track a job from the Jobs page or add one manually.</div>
      ) : (
        <div className="board">
          {STATUSES.map((s) => {
            const items = apps.filter((a) => a.status === s);
            return (
              <div className="col" key={s}>
                <div className="col-head"><span className={`dot ${s}`} /> {s}<span className="col-count">{items.length}</span></div>
                {items.map((a) => (
                  <div className="app-card" key={a.id} onClick={() => setSelected(a)}>
                    <div className="t">{title(a)}</div>
                    <div className="c">{a.job?.company ?? a.method ?? 'manual'}{a.job?.location ? ` · ${a.job.location}` : ''}</div>
                    <div className="row" style={{ marginTop: 8, gap: 6, alignItems: 'center' }}>
                      {a.job?.applyType && <ApplyBadge type={a.job.applyType} />}
                      {typeof a.job?.matchScore === 'number' && <span className="faint" style={{ fontSize: 11 }}>★ {a.job.matchScore}</span>}
                      <span className="faint" style={{ fontSize: 11, marginLeft: 'auto' }}>{fmtDate(a.updatedAt)}</span>
                    </div>
                    <div className="row" style={{ marginTop: 8, gap: 4 }}>
                      {NEXT[s].map((x) => (
                        <button key={x} className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); move(a, x); }}>→ {x.slice(0, 5)}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
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
    <Modal title={j?.title ?? 'Application'} onClose={onClose}
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
