import { useEffect, useMemo, useRef, useState } from 'react';
import { api, isAdminUI, type JobFilters, type IngestSummary, type IngestMetrics } from '../api/client';
import type { Job } from '../types';
import { ApplyBadge, ScoreBar, fmtDate, useToast } from '../lib/ui';
import { Modal } from '../components/Modal';

const FILTER_KEY = 'jobpilot_job_filters';
function loadStoredFilters(): JobFilters {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (raw) return { page: 0, size: 25, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  // Default to fresh jobs only (last 7 days) — older listings aren't useful.
  return { page: 0, size: 25, postedWithin: 7 };
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

  const [summary, setSummary] = useState<IngestSummary | null>(null);
  const [metrics, setMetrics] = useState<IngestMetrics | null>(null);
  const [showMetrics, setShowMetrics] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const admin = isAdminUI();

  const refreshSummary = () => { api.ingestSummary().then(setSummary).catch(() => {}); };
  useEffect(() => {
    refreshSummary();
    const t = setInterval(refreshSummary, 60000);
    return () => { clearInterval(t); if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // While an ingest runs (admin), poll the detailed metrics so the panel streams live.
  const pollMetrics = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    let sawRunning = false;
    const stop = () => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; };
    pollRef.current = setInterval(async () => {
      try {
        const m = await api.ingestMetrics();
        setMetrics(m);
        if (m.running) sawRunning = true;
        if (sawRunning && !m.running) {
          stop(); setIngesting(false); refreshSummary(); load(filters);
          toast(m.status === 'error' ? 'Ingest failed — see metrics' : 'Ingest complete ✓', m.status === 'error' ? 'error' : 'success');
        }
      } catch { stop(); setIngesting(false); }
    }, 2000);
    setTimeout(stop, 10 * 60 * 1000); // safety cap
  };

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

  const wipeAndReingest = async () => {
    if (!window.confirm('Delete ALL jobs from the database and pull a fresh set?\n\nYour tracked/saved jobs are kept. This cannot be undone.')) return;
    setIngesting(true);
    setShowMetrics(true);
    try {
      const w = await api.wipeJobs();
      toast(`Deleted ${w.deleted} jobs — starting fresh ingest…`, 'success');
      load(filters);
      await api.ingest();
      pollMetrics();
    } catch (e) { toast((e as Error).message, 'error'); setIngesting(false); }
  };

  const runIngest = async () => {
    setIngesting(true);
    setShowMetrics(true);
    try {
      const r = await api.ingest();
      if (r.status === 'busy') toast('A run is already in progress…', 'info');
      else toast('Ingest started — watch it live below', 'success');
      pollMetrics();
    } catch (e) { toast((e as Error).message, 'error'); setIngesting(false); }
  };

  const openMetrics = () => { setShowMetrics(true); api.ingestMetrics().then(setMetrics).catch((e) => toast(e.message, 'error')); };

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
        {admin && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={openMetrics} title="Ingest metrics & live log">📊 Metrics</button>
            <button className="btn btn-danger" onClick={wipeAndReingest} disabled={ingesting} title="Wipe all jobs and pull a fresh set">
              🗑 Reset DB
            </button>
            <button className="btn btn-primary" onClick={runIngest} disabled={ingesting}>
              {ingesting ? <span className="spinner" /> : '⟳'} Run ingest
            </button>
          </div>
        )}
      </div>

      {/* Last-ingest summary — shown to everyone at the top of the board. */}
      {summary?.lastRun && (
        <div className="card card-pad" style={{ marginBottom: 14, fontSize: 13, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 16 }}>📈</span>
          <span>
            Last ingest <b>{fmtDate(summary.lastRun.finishedAt)}</b> · <b style={{ color: 'var(--accent)' }}>+{summary.lastRun.inserted}</b> new ·
            {' '}<b>{summary.lastRun.updated}</b> unchanged · <b>{summary.totalJobs.toLocaleString()}</b> jobs on the board
          </span>
          {summary.running && <span className="row" style={{ gap: 6, color: 'var(--accent)' }}><span className="spinner" /> ingest running…</span>}
        </div>
      )}

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
      {showMetrics && admin && <MetricsModal m={metrics} running={ingesting} onClose={() => setShowMetrics(false)} />}
    </>
  );
}

function MetricsModal({ m, running, onClose }: { m: IngestMetrics | null; running: boolean; onClose: () => void }) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [m?.log?.length]);

  const statusColor = m?.status === 'error' ? 'var(--danger,#ef4444)' : m?.running ? 'var(--accent)' : 'var(--muted)';
  const mem = m?.memory;
  return (
    <Modal title="Ingest metrics" onClose={onClose} wide
      footer={<button className="btn btn-primary" onClick={onClose}>Close</button>}>
      {!m ? <div className="empty"><span className="spinner" /></div> : (
        <div style={{ display: 'grid', gap: 14 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <span className="badge" style={{ background: statusColor, color: '#fff' }}>
              {running || m.running ? 'running' : m.status}
            </span>
            <span className="faint" style={{ fontSize: 12 }}>
              {m.startedAt ? `started ${new Date(m.startedAt).toLocaleTimeString()}` : ''}
              {m.finishedAt ? ` · finished ${new Date(m.finishedAt).toLocaleTimeString()}` : ''}
            </span>
          </div>

          {m.lastRun && (
            <div className="card card-pad" style={{ padding: 12, fontSize: 13, background: 'var(--accent-soft)' }}>
              🕑 <b>Last completed ingest:</b> {fmtDate(m.lastRun.finishedAt)} —
              {' '}+{m.lastRun.inserted} new, {m.lastRun.updated} refreshed, {m.lastRun.fetched} scanned in {m.lastRun.durationSec}s.
            </div>
          )}

          <div className="grid2" style={{ gap: 10 }}>
            <Stat label="New jobs added" value={m.inserted} accent />
            <Stat label="Refreshed (unchanged)" value={m.updated} />
            <Stat label="Listings scanned" value={m.fetched} />
            <Stat label="Sources" value={`${m.sourcesDone} / ${m.sources}`} />
            <Stat label="Jobs on board" value={m.totalJobs} />
            {mem && <Stat label="Memory" value={`${mem.usedMb} / ${mem.maxMb} MB (${mem.usedPct}%)`} />}
          </div>

          {mem && (
            <div>
              <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>Heap memory</div>
              <div style={{ height: 8, background: 'var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, mem.usedPct)}%`, height: '100%', background: mem.usedPct > 85 ? 'var(--danger,#ef4444)' : 'var(--accent)' }} />
              </div>
            </div>
          )}

          <div>
            <div className="section-title" style={{ fontSize: 13 }}>What's happening</div>
            <div ref={logRef} style={{
              maxHeight: 220, overflowY: 'auto', background: '#0c0f15', borderRadius: 8, padding: 10,
              fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap',
            }}>
              {m.log.length ? m.log.join('\n') : 'No activity yet. Click “Run ingest” to start.'}
            </div>
          </div>

          {m.boards.length > 0 && (
            <div>
              <div className="section-title" style={{ fontSize: 13 }}>Collected per source</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {m.boards.map((b) => (
                  <span key={b.source} className="chip">{b.source}: <b>{b.count}</b></span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div className="card card-pad" style={{ padding: 12 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent ? 'var(--accent)' : undefined }}>{value}</div>
      <div className="faint" style={{ fontSize: 12 }}>{label}</div>
    </div>
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
