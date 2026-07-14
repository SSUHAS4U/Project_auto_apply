import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { PilotConfig, PilotCycle, PilotJobDetail, PilotJobSummary, PilotStatus } from '../types';
import { fmtDate, useToast } from '../lib/ui';

/**
 * Auto Apply — mission control. The engine runs on the server (daily cycle:
 * evaluate → draft → review → revise → compile → ATS-verify → apply); this page
 * only OBSERVES it. Controls are limited to pause/resume, run-now, and settings.
 */

const STAGES: { key: string; label: string; ico: string }[] = [
  { key: 'scraped', label: 'Backlog', ico: '🔎' },
  { key: 'evaluated', label: 'Evaluated', ico: '⚖️' },
  { key: 'drafted', label: 'Drafted', ico: '✍️' },
  { key: 'reviewed', label: 'Reviewed', ico: '🧐' },
  { key: 'revised', label: 'Revised', ico: '🔁' },
  { key: 'compiled', label: 'Compiled', ico: '📄' },
  { key: 'verified', label: 'ATS-verified', ico: '🔬' },
  { key: 'submitted', label: 'Submitted', ico: '📤' },
  { key: 'queued', label: 'Queued', ico: '🧾' },
  { key: 'skipped', label: 'Skipped', ico: '⏭' },
  { key: 'failed', label: 'Failed', ico: '⚠️' },
];

const STAGE_COLOR: Record<string, string> = {
  scraped: '#64748b', evaluated: '#0ea5e9', drafted: '#8b5cf6', reviewed: '#a855f7',
  revised: '#7c3aed', compiled: '#0891b2', verified: '#0d9488',
  submitted: '#16a34a', queued: '#2563eb', skipped: '#d97706', failed: '#dc2626',
};

const VERDICT_COLOR: Record<string, string> = {
  strong: '#16a34a', good: '#0d9488', moderate: '#d97706', weak: '#ea580c', poor: '#dc2626',
};

function Chip({ text, color }: { text: string; color: string }) {
  return (
    <span className="chip" style={{ background: color + '22', color, borderColor: color + '55' }}>
      {text}
    </span>
  );
}

type Dim = { score?: number; note?: string };
type Evaluation = {
  technical?: Dim; experience?: Dim; culture?: Dim; career?: Dim;
  location?: { result?: string; note?: string };
  weighted?: number; verdict?: string;
  strengths?: string[]; gaps?: string[]; recommendation?: string;
  requiredKeywords?: string[]; preferredKeywords?: string[];
};
type AtsReport = {
  ok?: boolean; error?: string; pages?: number; hasEmail?: boolean; hasPhone?: boolean; garbled?: boolean;
  requiredCovered?: string[]; requiredMissingHave?: string[]; requiredMissingGap?: string[];
  preferredCovered?: string[]; preferredMissing?: string[]; requiredCoveragePct?: number;
};
type StageLogEntry = { stage: string; at: string; note: string };

function parse<T>(s?: string): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

export function AutoApplyPage() {
  const toast = useToast();
  const [status, setStatus] = useState<PilotStatus | null>(null);
  const [jobs, setJobs] = useState<PilotJobSummary[]>([]);
  const [cyclesList, setCyclesList] = useState<PilotCycle[]>([]);
  const [stageFilter, setStageFilter] = useState('');
  const [detail, setDetail] = useState<PilotJobDetail | null>(null);
  const [openJob, setOpenJob] = useState('');
  const [tab, setTab] = useState<'pipeline' | 'queue' | 'cycles' | 'settings'>('pipeline');
  const [queue, setQueue] = useState<PilotJobSummary[]>([]);
  const [cfg, setCfg] = useState<PilotConfig | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.pilotStatus().then((s) => { setStatus(s); setCfg((c) => c ?? s.config); }).catch((e) => toast(e.message, 'error'));
    api.pilotJobs(stageFilter || undefined, 100).then(setJobs).catch(() => {});
    api.pilotQueue().then(setQueue).catch(() => {});
    api.pilotCycles().then(setCyclesList).catch(() => {});
  }, [toast, stageFilter]);

  useEffect(() => {
    load();
    const t = setInterval(load, 12000); // live while a cycle runs
    return () => clearInterval(t);
  }, [load]);

  const togglePause = async () => {
    if (!status) return;
    setBusy(true);
    try {
      const r = await api.pilotToggle(!status.enabled);
      toast(r.enabled
        ? 'Pilot resumed — the pipeline runs on schedule every day until you pause it.'
        : 'Pilot paused. Nothing is evaluated or sent until you resume.', 'success');
      load();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const r = await api.pilotRun();
      toast(r.message ?? r.status, r.status === 'started' ? 'success' : 'error');
      setTimeout(load, 1500);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  const saveConfig = async () => {
    if (!cfg) return;
    setBusy(true);
    try {
      setCfg(await api.pilotConfig(cfg));
      toast('Settings saved', 'success');
      load();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  const openDetail = (id: string) => {
    if (openJob === id) { setOpenJob(''); setDetail(null); return; }
    setOpenJob(id);
    setDetail(null);
    api.pilotJob(id).then(setDetail).catch((e) => toast((e as Error).message, 'error'));
  };

  const setQueueItem = async (id: string, s: 'applied' | 'dismissed') => {
    try {
      await api.pilotQueueStatus(id, s);
      setQueue((q) => q.filter((i) => i.id !== id));
      toast(s === 'applied' ? 'Marked applied — logged to Applications.' : 'Dismissed.', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const downloadPdf = async (id: string, kind: 'cv' | 'cover', name: string) => {
    try {
      const blob = await api.pilotPdf(id, kind);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast(`PDF not available (${(e as Error).message})`, 'error'); }
  };

  const enabled = status?.enabled ?? false;
  const counts = status?.stageCounts ?? {};

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            Auto Apply{' '}
            <Chip
              text={enabled ? (status?.running ? 'cycle running' : 'active · daily') : 'paused'}
              color={enabled ? (status?.running ? '#0ea5e9' : '#16a34a') : '#d97706'}
            />
          </h1>
          <div className="page-sub">
            The engine runs the full ai-job-search workflow on its own, job by job:
            {' '}<b>evaluate</b> (6-dimension weighted fit) → <b>draft</b> tailored CV + cover letter →
            {' '}independent <b>reviewer</b> critique → <b>revise</b> → <b>compile</b> PDF →
            {' '}<b>ATS verify</b> (text layer + keyword coverage) → <b>apply</b>. This page just watches it work.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={runNow} disabled={busy || !enabled || status?.running}
            title={enabled ? 'Run a full cycle now' : 'Resume first'}>
            {status?.running ? <span className="spinner" /> : '▶'} Run cycle
          </button>
          <button className={`btn ${enabled ? '' : 'btn-primary'}`} onClick={togglePause} disabled={busy || !status}
            style={enabled ? { background: '#dc2626', borderColor: '#dc2626', color: '#fff' } : undefined}>
            {enabled ? '⏸ Pause' : '▶ Resume'}
          </button>
        </div>
      </div>

      {status?.running && status.progress && (
        <div className="card card-pad" style={{ marginBottom: 14, fontSize: 13 }}>
          <span className="spinner" style={{ marginRight: 8 }} />{status.progress}
        </div>
      )}
      {!status?.aiEnabled && (
        <div className="card card-pad" style={{ marginBottom: 14, fontSize: 13, borderColor: '#d97706' }}>
          ⚠ No AI provider configured — the evaluate/draft/review stages need one. Set it in Settings → AI model.
        </div>
      )}

      {/* today tiles */}
      <div className="row" style={{ gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        {[
          { label: 'Submitted today', value: status?.submittedToday ?? '—', hint: 'tailored + emailed' },
          { label: 'Queued today', value: status?.queuedToday ?? '—', hint: 'documents ready for extension' },
          { label: 'Queue pending', value: status?.queuePending ?? '—', hint: 'awaiting your submit' },
          {
            label: 'Next cycle',
            value: status?.nextRunAt ? new Date(status.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—',
            hint: status?.nextRunAt ? new Date(status.nextRunAt).toLocaleDateString() : (enabled ? 'no schedule' : 'paused'),
          },
        ].map((s) => (
          <div key={s.label} className="card card-pad" style={{ flex: '1 1 140px', minWidth: 140 }}>
            <div className="faint" style={{ fontSize: 11.5, letterSpacing: '.05em', textTransform: 'uppercase' }}>{s.label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, marginTop: 2 }}>{s.value}</div>
            <div className="faint" style={{ fontSize: 12 }}>{s.hint}</div>
          </div>
        ))}
      </div>

      {/* pipeline board: stage counts, clickable filters */}
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {STAGES.map((s) => {
            const n = counts[s.key] ?? 0;
            const active = stageFilter === s.key;
            return (
              <button key={s.key} className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                onClick={() => { setStageFilter(active ? '' : s.key); setTab('pipeline'); }}
                title={`show ${s.label.toLowerCase()} jobs`}
                style={n === 0 && !active ? { opacity: 0.5 } : undefined}>
                {s.ico} {s.label} <b style={{ marginLeft: 4 }}>{n}</b>
              </button>
            );
          })}
        </div>
        {status?.lastOutcome && status.lastOutcome !== 'never run' && (
          <div className="faint" style={{ marginTop: 10, fontSize: 12.5 }}>Last cycle: {status.lastOutcome}</div>
        )}
      </div>

      {/* tabs */}
      <div className="row" style={{ gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {([['pipeline', `🛠 Pipeline${stageFilter ? ` · ${stageFilter}` : ''}`],
           ['queue', `🧾 Your queue (${status?.queuePending ?? queue.length})`],
           ['cycles', '🗓 Cycles'],
           ['settings', '⚙️ Settings']] as ['pipeline' | 'queue' | 'cycles' | 'settings', string][]).map(([t, label]) => (
          <button key={t} className={`btn btn-sm ${tab === t ? 'btn-primary' : ''}`} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>

      {tab === 'pipeline' && (
        jobs.length === 0 ? (
          <div className="card card-pad empty">
            <div className="big">🛠</div>
            {stageFilter ? `No jobs in "${stageFilter}".` : 'Nothing in the pipeline yet. Resume and Run cycle — jobs will appear here and move stage by stage.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {jobs.map((j) => (
              <div key={j.id} className="card card-pad" style={{ cursor: 'pointer' }} onClick={() => openDetail(j.id)}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <span className="pick-title">{j.jobTitle}</span>
                    <div className="job-company" style={{ marginTop: 4, fontSize: 13 }}>
                      <Chip text={j.stage} color={STAGE_COLOR[j.stage] ?? '#64748b'} />
                      {j.verdict && <> <Chip text={`${j.verdict} ${j.fitScore}/100`} color={VERDICT_COLOR[j.verdict] ?? '#64748b'} /></>}
                      {j.jobCompany && <> · {j.jobCompany}</>}
                      {j.jobLocation && <> · {j.jobLocation}</>}
                    </div>
                    {(j.skipReason || j.error) && (
                      <div className="faint" style={{ marginTop: 4, fontSize: 12.5 }}>{j.skipReason ?? j.error}</div>
                    )}
                  </div>
                  <div className="faint" style={{ fontSize: 12, flexShrink: 0, textAlign: 'right' }}>
                    {fmtDate(j.updatedAt)}<br />
                    {typeof j.matchScore === 'number' && <>quick fit {j.matchScore}</>}
                  </div>
                </div>

                {openJob === j.id && (
                  <div style={{ marginTop: 12, borderTop: '1px solid var(--border, #e2e8f0)', paddingTop: 10 }}
                    onClick={(e) => e.stopPropagation()}>
                    {!detail ? <span className="spinner" /> : <JobDetail d={detail} onPdf={downloadPdf} />}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'queue' && (
        queue.length === 0 ? (
          <div className="card card-pad empty">
            <div className="big">🧾</div>
            Queue is empty. Portal/ATS jobs land here with their tailored CV + letter ready —
            open, let the extension fill, submit, then confirm.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {queue.map((j) => (
              <div key={j.id} className="card card-pad">
                <div className="row" style={{ justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <a href={j.jobUrl} target="_blank" rel="noreferrer" className="pick-title" style={{ textDecoration: 'none' }}
                      onClick={() => api.pilotQueueStatus(j.id, 'opened').catch(() => {})}>
                      {j.jobTitle} ↗
                    </a>
                    <div className="job-company" style={{ marginTop: 4, fontSize: 13 }}>
                      {j.verdict && <Chip text={`${j.verdict} ${j.fitScore}/100`} color={VERDICT_COLOR[j.verdict] ?? '#64748b'} />}
                      {j.jobCompany && <> · {j.jobCompany}</>}
                    </div>
                  </div>
                </div>
                <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-sm" onClick={() => downloadPdf(j.id, 'cv', 'tailored-cv.pdf')}>📄 Tailored CV</button>
                  <button className="btn btn-sm" onClick={() => downloadPdf(j.id, 'cover', 'cover-letter.pdf')}>📄 Cover letter</button>
                  <span style={{ marginLeft: 'auto' }} />
                  <a className="btn btn-primary btn-sm" href={j.jobUrl} target="_blank" rel="noreferrer"
                    onClick={() => api.pilotQueueStatus(j.id, 'opened').catch(() => {})}>Open &amp; fill ↗</a>
                  <button className="btn btn-sm" onClick={() => setQueueItem(j.id, 'applied')}>✓ I applied</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setQueueItem(j.id, 'dismissed')}>✕</button>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'cycles' && (
        cyclesList.length === 0 ? (
          <div className="card card-pad empty"><div className="big">🗓</div>No cycles yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {cyclesList.map((c) => (
              <div key={c.id} className="card card-pad">
                <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <b>{fmtDate(c.startedAt)}</b>{' '}
                    <span className="chip">{c.trigger}</span>{' '}
                    <Chip text={c.status} color={c.status === 'failed' ? '#dc2626' : c.status === 'running' ? '#0ea5e9' : '#16a34a'} />
                  </div>
                  <div className="faint" style={{ fontSize: 13 }}>
                    🔎 {c.scanned} scanned · {c.picked} piped · 📤 {c.submitted} · 🧾 {c.queued} · ⏭ {c.skipped} · ⚠ {c.failed}
                  </div>
                </div>
                {(c.summary || c.error) && (
                  <div className="faint" style={{ marginTop: 6, fontSize: 12.5 }}>{c.error ?? c.summary}</div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'settings' && cfg && (
        <div className="card card-pad" style={{ maxWidth: 640 }}>
          <h3 style={{ marginTop: 0 }}>Pipeline settings</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={{ fontSize: 13 }}>Jobs per cycle
              <input className="input" type="number" min={1} max={100} value={cfg.maxPerCycle}
                onChange={(e) => setCfg({ ...cfg, maxPerCycle: +e.target.value })} />
              <span className="faint" style={{ fontSize: 11.5 }}>each takes ~5 AI calls (evaluate/draft/review/revise)</span>
            </label>
            <label style={{ fontSize: 13 }}>Minimum fit score
              <input className="input" type="number" min={0} max={100} value={cfg.minFitScore}
                onChange={(e) => setCfg({ ...cfg, minFitScore: +e.target.value })} />
              <span className="faint" style={{ fontSize: 11.5 }}>60 = the framework's "good fit — apply" bar</span>
            </label>
            <label style={{ fontSize: 13 }}>Email sends per day
              <input className="input" type="number" min={0} max={500} value={cfg.emailDailyCap}
                onChange={(e) => setCfg({ ...cfg, emailDailyCap: +e.target.value })} />
              <span className="faint" style={{ fontSize: 11.5 }}>with automatic backoff on mailbox failures</span>
            </label>
            <label style={{ fontSize: 13 }}>Look back (days)
              <input className="input" type="number" min={1} max={14} value={cfg.lookbackDays}
                onChange={(e) => setCfg({ ...cfg, lookbackDays: +e.target.value })} />
              <span className="faint" style={{ fontSize: 11.5 }}>posting freshness window</span>
            </label>
            <label className="row" style={{ fontSize: 13, gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={cfg.reviewerEnabled}
                onChange={(e) => setCfg({ ...cfg, reviewerEnabled: e.target.checked })} />
              Independent reviewer pass (two-agent workflow)
            </label>
            <label className="row" style={{ fontSize: 13, gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={cfg.tailorCv}
                onChange={(e) => setCfg({ ...cfg, tailorCv: e.target.checked })} />
              Tailor the LaTeX CV per job (needs a base resume in Resumes)
            </label>
            <label className="row" style={{ fontSize: 13, gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={cfg.ingestFirst}
                onChange={(e) => setCfg({ ...cfg, ingestFirst: e.target.checked })} />
              Refresh job sources before each scheduled cycle
            </label>
          </div>
          <div className="row" style={{ marginTop: 16, gap: 8 }}>
            <button className="btn btn-primary" onClick={saveConfig} disabled={busy}>Save settings</button>
            <span className="faint" style={{ fontSize: 12, alignSelf: 'center' }}>
              Daily schedule: 09:30 IST (JOBPILOT_AUTO_APPLY_CRON)
            </span>
          </div>
        </div>
      )}
    </>
  );
}

// ---- artifact detail (read-only) --------------------------------------------

function JobDetail({ d, onPdf }: { d: PilotJobDetail; onPdf: (id: string, kind: 'cv' | 'cover', name: string) => void }) {
  const ev = parse<Evaluation>(d.evaluation);
  const ats = parse<AtsReport>(d.atsReport);
  const log = parse<StageLogEntry[]>(d.stageLog) ?? [];
  const [show, setShow] = useState<'letter' | 'review' | 'latex' | ''>('');

  const dims: [string, Dim | undefined, string][] = ev ? [
    ['Technical skills (30%)', ev.technical, ''],
    ['Experience (25%)', ev.experience, ''],
    ['Culture fit (15%)', ev.culture, ''],
    ['Career alignment (30%)', ev.career, ''],
  ] : [];

  return (
    <div style={{ fontSize: 13 }}>
      {/* timeline */}
      <div style={{ marginBottom: 12 }}>
        <b>Timeline</b>
        {log.map((e, i) => (
          <div key={i} className="row" style={{ gap: 8, padding: '3px 0', flexWrap: 'wrap' }}>
            <Chip text={e.stage} color={STAGE_COLOR[e.stage] ?? '#64748b'} />
            <span className="faint" style={{ fontSize: 12 }}>{fmtDate(e.at)}</span>
            <span>{e.note}</span>
          </div>
        ))}
      </div>

      {/* evaluation table */}
      {ev && (
        <div style={{ marginBottom: 12 }}>
          <b>Fit evaluation</b>{' '}
          {ev.verdict && <Chip text={`${ev.verdict} · ${ev.weighted}/100`} color={VERDICT_COLOR[ev.verdict] ?? '#64748b'} />}
          {ev.location?.result && <> <Chip text={`location: ${ev.location.result}`}
            color={ev.location.result === 'pass' ? '#16a34a' : ev.location.result === 'fail' ? '#dc2626' : '#d97706'} /></>}
          <table style={{ width: '100%', marginTop: 6, borderCollapse: 'collapse' }}>
            <tbody>
              {dims.map(([label, dim]) => (
                <tr key={label} style={{ borderTop: '1px solid var(--border, #e2e8f0)' }}>
                  <td style={{ padding: '4px 8px 4px 0', whiteSpace: 'nowrap' }}>{label}</td>
                  <td style={{ padding: '4px 8px', fontWeight: 700 }}>{dim?.score ?? '—'}</td>
                  <td style={{ padding: '4px 0' }} className="faint">{dim?.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!!ev.strengths?.length && <div style={{ marginTop: 6 }}>💪 {ev.strengths.join(' · ')}</div>}
          {!!ev.gaps?.length && <div className="faint" style={{ marginTop: 2 }}>🕳 {ev.gaps.join(' · ')}</div>}
        </div>
      )}

      {/* ATS report */}
      {ats && !ats.error && (
        <div style={{ marginBottom: 12 }}>
          <b>ATS verification</b>{' '}
          <Chip text={`${ats.requiredCoveragePct ?? 0}% required keywords`}
            color={(ats.requiredCoveragePct ?? 0) >= 70 ? '#16a34a' : (ats.requiredCoveragePct ?? 0) >= 40 ? '#d97706' : '#dc2626'} />
          {' '}<Chip text={ats.hasEmail || ats.hasPhone ? 'contact readable' : 'contact MISSING'}
            color={ats.hasEmail || ats.hasPhone ? '#16a34a' : '#dc2626'} />
          {ats.garbled && <> <Chip text="garbled glyphs" color="#dc2626" /></>}
          <div style={{ marginTop: 4 }}>
            {!!ats.requiredCovered?.length && <div>✓ covered: {ats.requiredCovered.join(', ')}</div>}
            {!!ats.requiredMissingHave?.length && (
              <div style={{ color: '#d97706' }}>△ candidate has it, CV doesn't say it: {ats.requiredMissingHave.join(', ')}</div>
            )}
            {!!ats.requiredMissingGap?.length && (
              <div className="faint">✕ genuine gaps (kept honest, never stuffed): {ats.requiredMissingGap.join(', ')}</div>
            )}
          </div>
        </div>
      )}

      {/* tailoring decisions */}
      {d.tailoringSummary && (
        <div style={{ marginBottom: 12, whiteSpace: 'pre-wrap' }}>
          <b>Key tailoring decisions</b>
          <div className="faint" style={{ marginTop: 4 }}>{d.tailoringSummary}</div>
        </div>
      )}

      {/* artifacts */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {d.coverLetter && (
          <button className="btn btn-sm" onClick={() => setShow(show === 'letter' ? '' : 'letter')}>
            ✉ Cover letter {show === 'letter' ? '▴' : '▾'}
          </button>
        )}
        {d.reviewerFeedback && (
          <button className="btn btn-sm" onClick={() => setShow(show === 'review' ? '' : 'review')}>
            🧐 Reviewer critique {show === 'review' ? '▴' : '▾'}
          </button>
        )}
        {d.cvLatex && (
          <button className="btn btn-sm" onClick={() => setShow(show === 'latex' ? '' : 'latex')}>
            📐 CV LaTeX {show === 'latex' ? '▴' : '▾'}
          </button>
        )}
        {d.hasCvPdf && <button className="btn btn-sm" onClick={() => onPdf(d.id, 'cv', 'tailored-cv.pdf')}>⬇ CV PDF</button>}
        {d.hasCoverPdf && <button className="btn btn-sm" onClick={() => onPdf(d.id, 'cover', 'cover-letter.pdf')}>⬇ Letter PDF</button>}
        {d.jobUrl && <a className="btn btn-sm" href={d.jobUrl} target="_blank" rel="noreferrer">Posting ↗</a>}
      </div>
      {show === 'letter' && (
        <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8, fontFamily: 'inherit' }}>{d.coverLetter}</pre>
      )}
      {show === 'review' && (
        <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8, fontSize: 12 }}>{d.reviewerFeedback}
          {d.revisionNotes && `\n\n— APPLIED —\n${d.revisionNotes}`}</pre>
      )}
      {show === 'latex' && (
        <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8, fontSize: 11, maxHeight: 300, overflow: 'auto' }}>{d.cvLatex}</pre>
      )}
    </div>
  );
}
