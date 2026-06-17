import { useEffect, useMemo, useState } from 'react';
import { api, type JobFilters } from '../api/client';
import type { Job } from '../types';
import { ApplyBadge, ScoreBar, fmtDate, useToast } from '../lib/ui';
import { Modal } from '../components/Modal';

export function JobsPage() {
  const toast = useToast();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [ingesting, setIngesting] = useState(false);
  const [filters, setFilters] = useState<JobFilters>({ page: 0, size: 25 });
  const [applyJob, setApplyJob] = useState<Job | null>(null);

  const load = (f: JobFilters) => {
    setLoading(true);
    api.jobs(f)
      .then((p) => { setJobs(p.items); setTotal(p.total); })
      .catch((e) => toast(e.message, 'error'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(filters); /* eslint-disable-next-line */ }, [filters.page, filters.size]);

  const apply = (patch: Partial<JobFilters>) => {
    const next = { ...filters, ...patch, page: 0 };
    setFilters(next);
    load(next);
  };

  const runIngest = async () => {
    setIngesting(true);
    try {
      const r = await api.ingest();
      toast(`Ingest done — ${r.inserted} new, ${r.updated} updated`, 'success');
      load(filters);
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setIngesting(false); }
  };

  const track = async (j: Job) => {
    try { await api.trackJob(j.id); toast(`Tracking “${j.title}”`, 'success'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const stats = useMemo(() => {
    const emails = jobs.filter((j) => j.applyType === 'email').length;
    const avg = jobs.length ? Math.round(jobs.reduce((a, j) => a + (j.matchScore ?? 0), 0) / jobs.length) : 0;
    return { total, emails, avg };
  }, [jobs, total]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Jobs</h1>
          <div className="page-sub">Aggregated from Greenhouse, Lever, Ashby, Adzuna & Jooble</div>
        </div>
        <button className="btn btn-primary" onClick={runIngest} disabled={ingesting}>
          {ingesting ? <span className="spinner" /> : '⟳'} Run ingest
        </button>
      </div>

      <div className="stat-grid">
        <div className="card stat"><div className="stat-label">Jobs in view</div><div className="stat-value">{stats.total}</div></div>
        <div className="card stat"><div className="stat-label">Email-apply</div><div className="stat-value accent">{stats.emails}</div></div>
        <div className="card stat"><div className="stat-label">Avg match (page)</div><div className="stat-value">{stats.avg}</div></div>
      </div>

      <div className="toolbar">
        <input className="input" placeholder="Role / title…" defaultValue={filters.role}
          onKeyDown={(e) => e.key === 'Enter' && apply({ role: (e.target as HTMLInputElement).value })} />
        <input className="input" placeholder="Location…" defaultValue={filters.location}
          onKeyDown={(e) => e.key === 'Enter' && apply({ location: (e.target as HTMLInputElement).value })} />
        <select className="select" value={filters.applyType ?? ''} onChange={(e) => apply({ applyType: e.target.value || undefined })}>
          <option value="">All apply types</option>
          <option value="email">Email</option>
          <option value="ats">ATS</option>
          <option value="url">URL</option>
        </select>
        <select className="select" value={filters.minScore ?? ''} onChange={(e) => apply({ minScore: e.target.value ? Number(e.target.value) : undefined })}>
          <option value="">Any score</option>
          <option value="50">50+</option>
          <option value="65">65+</option>
          <option value="80">80+</option>
        </select>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Role</th><th>Location</th><th>Score</th><th>Apply</th><th>Posted</th><th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>
                  <div className="job-title">{j.title}</div>
                  <div className="job-company">{j.company ?? '—'} · <span className="faint">{j.source}</span></div>
                </td>
                <td className="muted">{j.location ?? (j.remote ? 'Remote' : '—')}</td>
                <td><ScoreBar score={j.matchScore} /></td>
                <td><ApplyBadge type={j.applyType} /></td>
                <td className="muted">{fmtDate(j.postedAt ?? j.fetchedAt)}</td>
                <td>
                  <div className="cell-actions">
                    {j.applyType === 'email' && (
                      <button className="btn btn-primary btn-sm" onClick={() => setApplyJob(j)}>Apply</button>
                    )}
                    <button className="btn btn-sm" onClick={() => track(j)}>Track</button>
                    <a className="btn btn-ghost btn-sm" href={j.url} target="_blank" rel="noreferrer">↗</a>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && jobs.length === 0 && (
              <tr><td colSpan={6}><div className="empty"><div className="big">🗂️</div>No jobs yet. Configure connectors in <code>.env</code> and click <b>Run ingest</b>.</div></td></tr>
            )}
            {loading && <tr><td colSpan={6}><div className="empty"><span className="spinner" /></div></td></tr>}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
        <button className="btn btn-sm" disabled={(filters.page ?? 0) <= 0}
          onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 0) - 1 }))}>← Prev</button>
        <span className="muted">Page {(filters.page ?? 0) + 1}</span>
        <button className="btn btn-sm" disabled={(jobs.length) < (filters.size ?? 25)}
          onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 0) + 1 }))}>Next →</button>
      </div>

      {applyJob && <EmailApplyModal job={applyJob} onClose={() => setApplyJob(null)} />}
    </>
  );
}

function EmailApplyModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const toast = useToast();
  const [letter, setLetter] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api.previewCoverLetter(job.id)
      .then((r) => setLetter(r.coverLetter))
      .catch((e) => toast(e.message, 'error'))
      .finally(() => setLoading(false));
  }, [job.id]); // eslint-disable-line

  const send = async () => {
    setSending(true);
    try {
      const r = await api.applyEmail(job.id, letter);
      toast(`Sent to ${r.sentTo}`, 'success');
      onClose();
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setSending(false); }
  };

  return (
    <Modal
      title={`Email apply — ${job.title}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={send} disabled={sending || loading}>
            {sending ? <span className="spinner" /> : '✉'} Send to {job.applyEmail}
          </button>
        </>
      }
    >
      <div className="muted">Review and edit the cover letter before sending. Resume on file will be attached.</div>
      {loading ? <div className="empty"><span className="spinner" /> generating…</div>
        : <textarea className="input" rows={16} value={letter} onChange={(e) => setLetter(e.target.value)} />}
    </Modal>
  );
}
