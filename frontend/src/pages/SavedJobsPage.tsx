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
    try { await api.promoteSaved(s.id); toast('Promoted → now a tracked application', 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Saved jobs</h1>
          <div className="page-sub">Listings you captured with the browser extension</div>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 18, display: 'flex', gap: 14, alignItems: 'flex-start', borderLeft: '3px solid var(--accent)' }}>
        <span style={{ fontSize: 22 }}>🔖</span>
        <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
          <b>What this is:</b> when you browse <b>LinkedIn / Naukri / Indeed</b> and find a job worth keeping,
          click the extension's <b>“Save to JobPilot”</b> button — it lands here. Then <b>Promote</b> a saved
          listing to turn it into a tracked application (it appears on the <b>Applications</b> board and gets a match score).
          <div className="faint" style={{ marginTop: 4 }}>This is how jobs from sites we can't legally fetch server-side still make it into your tracker.</div>
        </div>
      </div>

      {loading ? <div className="empty"><span className="spinner" /></div>
        : saved.length === 0 ? (
          <div className="card card-pad empty">
            <div className="big">🗂️</div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>No saved jobs yet</div>
            <div className="muted" style={{ maxWidth: 460, margin: '0 auto' }}>
              Install the extension (Settings → see the guide), open a job on LinkedIn/Naukri/Indeed,
              and hit <b>Save to JobPilot</b>. It’ll show up here ready to promote.
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
            {saved.map((s) => (
              <div key={s.id} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <a href={s.url} target="_blank" rel="noreferrer" className="job-title" style={{ fontSize: 15 }}>{s.title ?? 'Untitled listing'}</a>
                  <span className="chip">{s.sourceSite ?? 'web'}</span>
                </div>
                <div className="muted" style={{ fontSize: 13 }}>{s.company ?? '—'}{s.location ? ` · ${s.location}` : ''}</div>
                <div className="faint" style={{ fontSize: 12 }}>Captured {fmtDate(s.createdAt)}</div>
                <div className="row" style={{ marginTop: 'auto', paddingTop: 8, gap: 8 }}>
                  {s.promotedJobId
                    ? <span className="badge badge-ats">✓ Promoted</span>
                    : <button className="btn btn-primary btn-sm" onClick={() => promote(s)}>Promote to tracker</button>}
                  <a className="btn btn-ghost btn-sm" href={s.url} target="_blank" rel="noreferrer">Open ↗</a>
                </div>
              </div>
            ))}
          </div>
        )}
    </>
  );
}
