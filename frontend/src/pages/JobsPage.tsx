import { useEffect, useMemo, useState } from 'react';
import { api, type JobFilters } from '../api/client';
import type { Job } from '../types';
import { ApplyBadge, ScoreBar, fmtDate, useToast } from '../lib/ui';
import { Modal } from '../components/Modal';

const FILTER_KEY = 'jobpilot_job_filters';
function loadStoredFilters(): JobFilters {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (raw) return { page: 0, size: 25, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { page: 0, size: 25 };
}

export function JobsPage() {
  const toast = useToast();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [ingesting, setIngesting] = useState(false);
  const [filters, setFilters] = useState<JobFilters>(loadStoredFilters);
  const [formKey, setFormKey] = useState(0); // remount inputs when filters reset externally
  const [applyJob, setApplyJob] = useState<Job | null>(null);
  const [detailJob, setDetailJob] = useState<Job | null>(null);
  const [view, setView] = useState<'table' | 'cards'>(
    () => (localStorage.getItem('jobpilot_jobs_view') as 'table' | 'cards')
      || (typeof window !== 'undefined' && window.innerWidth < 860 ? 'cards' : 'table'));
  const chooseView = (v: 'table' | 'cards') => { localStorage.setItem('jobpilot_jobs_view', v); setView(v); };

  const load = (f: JobFilters) => {
    setLoading(true);
    api.jobs(f)
      .then((p) => { setJobs(p.items); setTotal(p.total); })
      .catch((e) => toast(e.message, 'error'))
      .finally(() => setLoading(false));
  };

  // Persist filters (minus paging) so they survive reload/navigation until cleared.
  useEffect(() => {
    const { page, size, ...persist } = filters;
    void page; void size;
    localStorage.setItem(FILTER_KEY, JSON.stringify(persist));
  }, [filters]);

  useEffect(() => { load(filters); /* eslint-disable-next-line */ }, [filters.page, filters.size]);

  const apply = (patch: Partial<JobFilters>) => {
    const next = { ...filters, ...patch, page: 0 };
    setFilters(next);
    load(next);
  };

  const clearOne = (key: keyof JobFilters) => { apply({ [key]: undefined } as Partial<JobFilters>); setFormKey((k) => k + 1); };
  const clearAll = () => { const next = { page: 0, size: 25 }; setFilters(next); load(next); setFormKey((k) => k + 1); };

  const activeChips = ([
    ['role', filters.role && `Role: ${filters.role}`],
    ['location', filters.location && `Location: ${filters.location}`],
    ['applyType', filters.applyType && `Apply: ${filters.applyType}`],
    ['minScore', filters.minScore && `Score ≥ ${filters.minScore}`],
    ['region', filters.region && `Region: ${filters.region}`],
    ['postedWithin', filters.postedWithin && `≤ ${filters.postedWithin}d old`],
  ] as [keyof JobFilters, string | undefined][]).filter(([, v]) => v);

  const runIngest = async () => {
    setIngesting(true);
    try {
      const r = await api.ingest();
      if (r.status === 'busy') { toast('A run is already in progress…', 'info'); }
      else { toast('Ingest started in the background — jobs will refresh shortly', 'success'); }
      // Poll until the background run finishes, then reload.
      const poll = setInterval(async () => {
        try {
          const st = await api.opsStatus();
          if (!st.running) { clearInterval(poll); setIngesting(false); load(filters); toast(st.last, 'success'); }
        } catch { clearInterval(poll); setIngesting(false); }
      }, 5000);
    } catch (e) { toast((e as Error).message, 'error'); setIngesting(false); }
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

      <div className="tabs">
        {([
          { k: '', label: 'All' },
          { k: 'india', label: '🇮🇳 India' },
          { k: 'remote', label: '🌐 Remote' },
          { k: 'outside', label: 'Outside India' },
        ] as const).map((t) => (
          <div key={t.k} className={`tab ${(filters.region ?? '') === t.k ? 'active' : ''}`}
            onClick={() => apply({ region: t.k || undefined })}>{t.label}</div>
        ))}
        <a className="tab" href="/daily" style={{ marginLeft: 'auto' }}>☀️ AI Picks →</a>
      </div>

      <div className="stat-grid">
        <div className="card stat"><div className="stat-label">Jobs in view</div><div className="stat-value">{stats.total}</div></div>
        <div className="card stat"><div className="stat-label">Email-apply</div><div className="stat-value accent">{stats.emails}</div></div>
        <div className="card stat"><div className="stat-label">Avg match (page)</div><div className="stat-value">{stats.avg}</div></div>
      </div>

      <div className="toolbar" key={formKey}>
        <input className="input" placeholder="Role / title…  (Enter)" defaultValue={filters.role}
          onKeyDown={(e) => e.key === 'Enter' && apply({ role: (e.target as HTMLInputElement).value || undefined })} />
        <input className="input" placeholder="Location…  (Enter)" defaultValue={filters.location}
          onKeyDown={(e) => e.key === 'Enter' && apply({ location: (e.target as HTMLInputElement).value || undefined })} />
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
        <select className="select" value={filters.postedWithin ?? ''} onChange={(e) => apply({ postedWithin: e.target.value ? Number(e.target.value) : undefined })}>
          <option value="">Any date</option>
          <option value="1">Last 24h</option>
          <option value="3">Last 3 days</option>
          <option value="7">Last week</option>
        </select>
        <div className="segmented" style={{ marginLeft: 'auto' }}>
          <button className={view === 'cards' ? 'on' : ''} onClick={() => chooseView('cards')} title="Card view">▦</button>
          <button className={view === 'table' ? 'on' : ''} onClick={() => chooseView('table')} title="Table view">≣</button>
        </div>
      </div>

      {activeChips.length > 0 && (
        <div className="row" style={{ gap: 8, marginBottom: 16, alignItems: 'center' }}>
          <span className="faint" style={{ fontSize: 12 }}>Active filters:</span>
          {activeChips.map(([key, label]) => (
            <span key={key} className="filter-chip">
              {label}
              <button className="filter-chip-x" title="Remove" onClick={() => clearOne(key)}>✕</button>
            </span>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={clearAll}>Clear all</button>
        </div>
      )}

      {loading ? <div className="empty"><span className="spinner" /></div>
        : jobs.length === 0 ? (
          <div className="card card-pad empty"><div className="big">🗂️</div>No jobs in this view. Adjust filters or click <b>Run ingest</b>.</div>
        ) : view === 'cards' ? (
          <div className="job-grid">
            {jobs.map((j) => (
              <div key={j.id} className="job-card">
                <div className="job-card-top">
                  <div className="job-title" style={{ cursor: 'pointer' }} onClick={() => setDetailJob(j)}>{j.title}</div>
                  <ApplyBadge type={j.applyType} />
                </div>
                <div className="job-company">{j.company ?? '—'} · <span className="faint">{j.source}</span></div>
                <div className="muted" style={{ fontSize: 12.5, margin: '6px 0' }}>📍 {j.location ?? (j.remote ? 'Remote' : '—')} · {fmtDate(j.postedAt ?? j.fetchedAt)}</div>
                <div className="row" style={{ alignItems: 'center', gap: 10 }}>
                  <ScoreBar score={j.matchScore} />
                </div>
                <div className="row" style={{ marginTop: 'auto', paddingTop: 12, gap: 7 }}>
                  {j.applyType === 'email' && <button className="btn btn-primary btn-sm" onClick={() => setApplyJob(j)}>Apply</button>}
                  <button className="btn btn-sm" onClick={() => track(j)}>Track</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setDetailJob(j)}>Details</button>
                  <a className="btn btn-ghost btn-sm" href={j.url} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto' }}>↗</a>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Role</th><th>Location</th><th>Score</th><th>Apply</th><th>Posted</th><th></th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <div className="job-title" style={{ cursor: 'pointer' }} onClick={() => setDetailJob(j)}>{j.title}</div>
                      <div className="job-company">{j.company ?? '—'} · <span className="faint">{j.source}</span></div>
                    </td>
                    <td className="muted">{j.location ?? (j.remote ? 'Remote' : '—')}</td>
                    <td><ScoreBar score={j.matchScore} /></td>
                    <td><ApplyBadge type={j.applyType} /></td>
                    <td className="muted">{fmtDate(j.postedAt ?? j.fetchedAt)}</td>
                    <td>
                      <div className="cell-actions">
                        {j.applyType === 'email' && <button className="btn btn-primary btn-sm" onClick={() => setApplyJob(j)}>Apply</button>}
                        <button className="btn btn-sm" onClick={() => track(j)}>Track</button>
                        <a className="btn btn-ghost btn-sm" href={j.url} target="_blank" rel="noreferrer">↗</a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
        <button className="btn btn-sm" disabled={(filters.page ?? 0) <= 0}
          onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 0) - 1 }))}>← Prev</button>
        <span className="muted">Page {(filters.page ?? 0) + 1}</span>
        <button className="btn btn-sm" disabled={(jobs.length) < (filters.size ?? 25)}
          onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 0) + 1 }))}>Next →</button>
      </div>

      {applyJob && <EmailApplyModal job={applyJob} onClose={() => setApplyJob(null)} />}
      {detailJob && (
        <JobDetailModal
          job={detailJob}
          onClose={() => setDetailJob(null)}
          onTrack={() => track(detailJob)}
          onApply={() => { setDetailJob(null); setApplyJob(detailJob); }}
        />
      )}
    </>
  );
}

function JobDetailModal({ job, onClose, onTrack, onApply }: {
  job: Job; onClose: () => void; onTrack: () => void; onApply: () => void;
}) {
  return (
    <Modal title={job.title} onClose={onClose} wide
      footer={<>
        <a className="btn btn-ghost" href={job.url} target="_blank" rel="noreferrer">Open posting ↗</a>
        <button className="btn" onClick={onTrack}>Track</button>
        {job.applyType === 'email' && <button className="btn btn-primary" onClick={onApply}>✉ Email apply</button>}
      </>}>
      <dl className="detail-grid">
        <dt>Company</dt><dd>{job.company ?? '—'}</dd>
        <dt>Location</dt><dd>{job.location ?? (job.remote ? 'Remote' : '—')}</dd>
        <dt>Source</dt><dd>{job.source}</dd>
        <dt>Apply</dt><dd><ApplyBadge type={job.applyType} />{job.applyEmail ? ` · ${job.applyEmail}` : ''}</dd>
        <dt>Match score</dt><dd><ScoreBar score={job.matchScore} /></dd>
        {job.salaryText && <><dt>Salary</dt><dd>{job.salaryText}</dd></>}
        <dt>Posted</dt><dd>{fmtDate(job.postedAt ?? job.fetchedAt)}</dd>
      </dl>
      {job.description && <div className="job-desc">{job.description}</div>}
    </Modal>
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
