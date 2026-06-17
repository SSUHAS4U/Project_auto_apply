import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { SavedJob } from '../types';
import { fmtDate, useToast } from '../lib/ui';

export function SavedJobsPage() {
  const toast = useToast();
  const [saved, setSaved] = useState<SavedJob[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.savedJobs().then(setSaved).catch((e) => toast(e.message, 'error')).finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line

  const promote = async (s: SavedJob) => {
    try { await api.promoteSaved(s.id); toast('Promoted to tracked job', 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Saved jobs</h1>
          <div className="page-sub">Captured by the browser extension from LinkedIn / Naukri / Indeed</div>
        </div>
      </div>

      {loading ? <div className="empty"><span className="spinner" /></div>
        : saved.length === 0 ? (
          <div className="card card-pad empty">
            <div className="big">🔖</div>
            No saved jobs yet. Use the “Save to JobPilot” button the extension injects on job pages.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Role</th><th>Company</th><th>Site</th><th>Captured</th><th></th></tr></thead>
              <tbody>
                {saved.map((s) => (
                  <tr key={s.id}>
                    <td><a href={s.url} target="_blank" rel="noreferrer" className="job-title">{s.title ?? 'Untitled'}</a>
                      <div className="job-company">{s.location ?? ''}</div></td>
                    <td className="muted">{s.company ?? '—'}</td>
                    <td><span className="chip">{s.sourceSite ?? 'web'}</span></td>
                    <td className="muted">{fmtDate(s.createdAt)}</td>
                    <td><div className="cell-actions">
                      {s.promotedJobId ? <span className="badge badge-ats">Promoted</span>
                        : <button className="btn btn-primary btn-sm" onClick={() => promote(s)}>Promote</button>}
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </>
  );
}
