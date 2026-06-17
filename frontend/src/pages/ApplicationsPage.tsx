import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Application, ApplicationEvent, ApplicationStatus } from '../types';
import { fmtDate, useToast } from '../lib/ui';
import { Modal } from '../components/Modal';

const STATUSES: ApplicationStatus[] = ['interested', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn'];

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

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Applications</h1>
          <div className="page-sub">{apps.length} tracked · drag through the pipeline</div>
        </div>
      </div>

      {loading ? <div className="empty"><span className="spinner" /></div> : (
        <div className="board">
          {STATUSES.map((s) => {
            const items = apps.filter((a) => a.status === s);
            return (
              <div className="col" key={s}>
                <div className="col-head">
                  <span className={`dot ${s}`} /> {s}
                  <span className="col-count">{items.length}</span>
                </div>
                {items.map((a) => (
                  <div className="app-card" key={a.id} onClick={() => setSelected(a)}>
                    <div className="t">{a.jobId ? a.jobId.slice(0, 8) : 'Manual'}</div>
                    <div className="c">{a.method ?? 'manual'} · {fmtDate(a.updatedAt)}</div>
                    <div className="row" style={{ marginTop: 8, gap: 4 }}>
                      {STATUSES.filter((x) => x !== s).slice(0, 2).map((x) => (
                        <button key={x} className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); move(a, x); }}>
                          → {x.slice(0, 4)}
                        </button>
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
      toast('Saved', 'success');
      onChanged();
      onClose();
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <Modal
      title="Application"
      onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={save}>Save</button></>}
    >
      <label className="field">Status
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value as ApplicationStatus)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className="field">Notes
        <textarea className="input" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {app.coverLetter && (
        <label className="field">Cover letter sent<div className="pre">{app.coverLetter}</div></label>
      )}
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
