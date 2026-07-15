import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type {
  EngineApplication, EngineApplicationSummary, EngineDoc, EngineInterview, EngineJob,
  EnginePrefill, EngineProfile, EngineStatus, EngineUpskill,
} from '../types';
import { fmtDate, useToast } from '../lib/ui';

/**
 * Auto Apply — a clean-room replica of the ai-job-search framework, built as its own
 * component (backend package com.jobpilot.engine, tables engine_*, API /api/engine/**).
 * It shares only generic plumbing (AI, LaTeX compile, PDF, mail) with the rest of the app.
 * Flow: Setup → Scrape → Rank → Apply (draft → review → revise → compile → ATS verify)
 *       → Outcome → Interview → Upskill.
 */

type Tab = 'setup' | 'jobs' | 'applications' | 'interview' | 'upskill';

const VERDICT_COLOR: Record<string, string> = {
  strong: '#34d399', good: '#60a5fa', moderate: '#fbbf24', weak: '#f59e0b', poor: '#f87171',
};
const STAGE_COLOR: Record<string, string> = {
  parsing: '#7d8595', evaluating: '#60a5fa', drafting: '#a78bfa', reviewing: '#a78bfa',
  revising: '#818cf8', compiling: '#22d3ee', verifying: '#2dd4bf',
  ready: '#34d399', submitted: '#16a34a', failed: '#f87171', vetoed: '#f59e0b',
};

const DOC_LABELS: Record<string, string> = {
  candidate: '01 · Candidate profile', behavioral: '02 · Behavioral profile',
  writingStyle: '03 · Writing style', evaluation: '04 · Evaluation lens',
  cvTemplate: '05 · CV template (LaTeX)', coverTemplate: '06 · Cover template (LaTeX)',
  interviewPrep: '07 · Interview prep', searchQueries: 'Search queries (JSON)',
};
const DOC_FIELD: Record<string, keyof EngineProfile> = {
  candidate: 'candidateMd', behavioral: 'behavioralMd', writingStyle: 'writingStyleMd',
  evaluation: 'evaluationMd', cvTemplate: 'cvTemplateLatex', coverTemplate: 'coverTemplateLatex',
  interviewPrep: 'interviewPrepMd', searchQueries: 'searchQueries',
};

function Chip({ text, color }: { text: string; color: string }) {
  return (
    <span className="chip" style={{ background: color + '22', color, borderColor: color + '55' }}>{text}</span>
  );
}

export function EnginePage() {
  const toast = useToast();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [tab, setTab] = useState<Tab>('setup');

  const loadStatus = useCallback(() => {
    api.engineStatus().then(setStatus).catch((e) => toast(e.message, 'error'));
  }, [toast]);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 5000); // live while scrape/rank runs
    return () => clearInterval(t);
  }, [loadStatus]);

  const busy = status?.scrapeRunning || status?.rankRunning;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            Auto Apply{' '}
            <Chip text="AI Job Search engine" color="#818cf8" />
            {status && !status.aiEnabled && <> <Chip text="AI off" color="#f87171" /></>}
            {status?.setupReady && <> <Chip text="setup ready" color="#34d399" /></>}
          </h1>
          <div className="page-sub">
            A self-contained replica of the ai-job-search workflow:
            {' '}<b>Setup</b> your profile → <b>Scrape</b> LinkedIn → <b>Rank</b> the matches →
            {' '}<b>Apply</b> (draft · independent review · revise · compile · ATS-verify) →
            {' '}record <b>Outcome</b> → <b>Interview</b> prep → <b>Upskill</b>.
          </div>
        </div>
        {busy && (
          <div className="row" style={{ gap: 8, alignItems: 'center', fontSize: 13 }}>
            <span className="spinner" />
            {status?.scrapeProgress || status?.rankProgress || 'Working…'}
          </div>
        )}
      </div>

      {status && !status.aiEnabled && (
        <div className="card card-pad" style={{ marginBottom: 14, borderColor: '#f59e0b', fontSize: 13 }}>
          ⚠ No AI provider configured — Setup, Rank and Apply need one. Add it in Settings → AI model.
        </div>
      )}

      {status && <AutopilotBanner status={status} onChange={loadStatus} />}

      <div className="row" style={{ gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {([
          ['setup', '① Setup'],
          ['jobs', `② Jobs${count(status?.jobStatusCounts)}`],
          ['applications', `③ Applications${count(status?.appStageCounts)}`],
          ['interview', '④ Interview'],
          ['upskill', '⑤ Upskill'],
        ] as [Tab, string][]).map(([t, label]) => (
          <button key={t} className={`btn btn-sm ${tab === t ? 'btn-primary' : ''}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'setup' && <SetupTab status={status} onChange={loadStatus} />}
      {tab === 'jobs' && <JobsTab status={status} onChange={loadStatus} onApplied={() => setTab('applications')} />}
      {tab === 'applications' && <ApplicationsTab />}
      {tab === 'interview' && <InterviewTab />}
      {tab === 'upskill' && <UpskillTab />}
    </>
  );
}

function count(m?: Record<string, number>): string {
  if (!m) return '';
  const total = Object.values(m).reduce((a, b) => a + b, 0);
  return total ? ` (${total})` : '';
}

// ---- Autopilot banner (the daily self-running cycle) ------------------------

function AutopilotBanner({ status, onChange }: { status: EngineStatus; onChange: () => void }) {
  const toast = useToast();
  const a = status.autopilot;
  const [cap, setCap] = useState(a.dailyCap);
  const [minFit, setMinFit] = useState(a.minFit);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setCap(a.dailyCap); setMinFit(a.minFit); }, [a.dailyCap, a.minFit]);

  const toggle = async () => {
    setBusy(true);
    try {
      const r = await api.engineAutopilotToggle(!a.enabled);
      toast(r.enabled
        ? 'Autopilot ON — it runs the full cycle every day at 09:30 IST and applies for you.'
        : 'Autopilot off. Nothing runs automatically.', 'success');
      onChange();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true);
    try { await api.engineAutopilotRun(); toast('Cycle started — scraping, ranking, then applying to the best matches…', 'success'); setTimeout(onChange, 1500); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const saveCfg = async () => {
    try { await api.engineAutopilotConfig(cap, minFit); toast('Saved', 'success'); onChange(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 14, borderColor: a.enabled ? '#34d399' : undefined }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            🤖 Autopilot{' '}
            <Chip text={a.enabled ? (a.running ? 'running now' : 'ON · daily 09:30') : 'off'}
              color={a.enabled ? (a.running ? '#60a5fa' : '#34d399') : '#7d8595'} />
          </div>
          <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>
            Runs the whole cycle by itself every day — scrape → rank → apply the top {a.dailyCap} best-fit jobs (fit ≥ {a.minFit}).
            {a.lastRunSummary ? ` Last run: ${a.lastRunSummary}` : ' Not run yet.'}
          </div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={runNow} disabled={busy || a.running || !status.setupReady}
            title={status.setupReady ? 'Run the full cycle now' : 'Finish Setup first'}>
            {a.running ? <span className="spinner" /> : '▶'} Run now
          </button>
          <button className="btn btn-sm" onClick={() => setOpen((v) => !v)}>⚙ Limits</button>
          <button className={`btn btn-sm ${a.enabled ? '' : 'btn-primary'}`} onClick={toggle} disabled={busy || !status.setupReady}
            style={a.enabled ? { background: '#dc2626', borderColor: '#dc2626', color: '#fff' } : undefined}>
            {a.enabled ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      </div>
      {open && (
        <div className="row" style={{ gap: 14, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: 12.5 }}>Applies per day
            <input className="input" type="number" min={0} max={200} style={{ width: 90, display: 'block' }}
              value={cap} onChange={(e) => setCap(+e.target.value)} />
          </label>
          <label style={{ fontSize: 12.5 }}>Minimum fit
            <input className="input" type="number" min={0} max={100} style={{ width: 90, display: 'block' }}
              value={minFit} onChange={(e) => setMinFit(+e.target.value)} />
          </label>
          <button className="btn btn-primary btn-sm" onClick={saveCfg}>Save limits</button>
          <span className="faint" style={{ fontSize: 11.5 }}>Each application uses ~5 AI calls — keep the cap sane on free AI tiers.</span>
        </div>
      )}
    </div>
  );
}

// ---- Setup ------------------------------------------------------------------

function SetupTab({ status, onChange }: { status: EngineStatus | null; onChange: () => void }) {
  const toast = useToast();
  const [profile, setProfile] = useState<EngineProfile | null>(null);
  const [me, setMe] = useState<EnginePrefill | null>(null);
  const [roles, setRoles] = useState('');
  const [locations, setLocations] = useState('');
  const [careerGoal, setCareerGoal] = useState('');
  const [dealBreakers, setDealBreakers] = useState('');
  const [wins, setWins] = useState('');
  const [saving, setSaving] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [openDoc, setOpenDoc] = useState('');
  const [draft, setDraft] = useState('');

  useEffect(() => {
    api.engineProfile().then((p) => {
      setProfile(p);
      // Restore whatever was saved so the fields survive a refresh.
      if (p.guidedInputs) {
        try {
          const g = JSON.parse(p.guidedInputs);
          if (Array.isArray(g.roles) && g.roles.length) setRoles(g.roles.join(', '));
          if (Array.isArray(g.locations) && g.locations.length) setLocations(g.locations.join(', '));
          if (g.careerGoal) setCareerGoal(g.careerGoal);
          if (Array.isArray(g.dealBreakers) && g.dealBreakers.length) setDealBreakers(g.dealBreakers.join(', '));
          if (g.wins) setWins(g.wins);
        } catch { /* ignore */ }
      }
    }).catch(() => {});
    api.enginePrefill().then((p) => {
      setMe(p);
      // pre-fill target inputs from what we already know, only if still blank
      setRoles((r) => r || [p.currentTitle, p.headline].filter(Boolean).join(', '));
      setLocations((l) => l || [p.location, ...(p.preferredLocations || [])].filter(Boolean).join(', '));
    }).catch(() => {});
  }, []);

  const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  const saveGuided = async () => {
    if (csv(roles).length === 0) { toast('Add at least one target role', 'error'); return; }
    setSaving(true);
    try {
      const p = await api.engineGuided({
        roles: csv(roles), locations: csv(locations),
        careerGoal, dealBreakers: csv(dealBreakers), wins,
      });
      setProfile(p);
      toast('Saved ✓ — you can Scrape now. (AI polish below is optional.)', 'success');
      onChange();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setSaving(false); }
  };

  const enhance = async () => {
    setEnhancing(true);
    try {
      const p = await api.engineSetup({ useStoredResume: true });
      setProfile(p);
      toast('AI-polished your documents ✓', 'success');
      onChange();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setEnhancing(false); }
  };

  const openEditor = (doc: string) => {
    if (openDoc === doc) { setOpenDoc(''); return; }
    setOpenDoc(doc); setDraft((profile?.[DOC_FIELD[doc]] as string) ?? '');
  };
  const saveDoc = async (doc: string) => {
    try { const p = await api.engineSaveDoc(doc as EngineDoc, draft); setProfile(p); toast('Saved ✓', 'success'); onChange(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const checklist = status?.checklist ?? {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Step 1 — your details (from the app Profile) */}
      <div className="card card-pad">
        <h3 style={{ marginTop: 0 }}>1 · Your details</h3>
        {me ? (
          <>
            <div className="row" style={{ gap: 18, flexWrap: 'wrap', fontSize: 13.5 }}>
              <div><div className="faint" style={{ fontSize: 11 }}>NAME</div>{me.fullName || <em className="faint">— add in Profile</em>}</div>
              <div><div className="faint" style={{ fontSize: 11 }}>EMAIL</div>{me.email || '—'}</div>
              <div><div className="faint" style={{ fontSize: 11 }}>PHONE</div>{me.phone || '—'}</div>
              <div><div className="faint" style={{ fontSize: 11 }}>CURRENT ROLE</div>{me.currentTitle || '—'}{me.currentCompany ? ` @ ${me.currentCompany}` : ''}</div>
              <div><div className="faint" style={{ fontSize: 11 }}>EXPERIENCE</div>{me.yearsExperience || '—'}</div>
              <div><div className="faint" style={{ fontSize: 11 }}>RESUME</div>{me.hasResume ? '✓ uploaded' : '✕ none'}</div>
            </div>
            {me.skills?.length > 0 && (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                {me.skills.slice(0, 16).map((s) => <span key={s} className="chip">{s}</span>)}
              </div>
            )}
            <div className="faint" style={{ fontSize: 12, marginTop: 10 }}>
              These come from your <a href="/profile">Profile</a> — edit there. {!me.hasResume && 'Upload a resume in Profile to enable AI CV tailoring.'}
            </div>
          </>
        ) : <span className="spinner" />}
      </div>

      {/* Step 2 — what you're looking for (no AI needed) */}
      <div className="card card-pad">
        <h3 style={{ marginTop: 0 }}>2 · What you're looking for</h3>
        <p className="faint" style={{ fontSize: 13, marginTop: 0 }}>
          This is all the engine needs to start finding &amp; ranking jobs — no AI required. Separate multiple entries with commas.
        </p>
        <div style={{ display: 'grid', gap: 12 }}>
          <label style={{ fontSize: 13 }}>Target roles <span className="faint">— job titles to search</span>
            <input className="input" style={{ width: '100%' }} value={roles} onChange={(e) => setRoles(e.target.value)}
              placeholder="e.g. Full-Stack Developer, Java Backend Engineer, React Developer" />
          </label>
          <label style={{ fontSize: 13 }}>Locations <span className="faint">— cities + Remote</span>
            <input className="input" style={{ width: '100%' }} value={locations} onChange={(e) => setLocations(e.target.value)}
              placeholder="e.g. Bengaluru, Hyderabad, Remote" />
          </label>
          <label style={{ fontSize: 13 }}>Career goal <span className="faint">— one line</span>
            <input className="input" style={{ width: '100%' }} value={careerGoal} onChange={(e) => setCareerGoal(e.target.value)}
              placeholder="e.g. Grow into a backend-heavy full-stack role at a product company" />
          </label>
          <label style={{ fontSize: 13 }}>Deal-breakers <span className="faint">— auto-reject if a job has these</span>
            <input className="input" style={{ width: '100%' }} value={dealBreakers} onChange={(e) => setDealBreakers(e.target.value)}
              placeholder="e.g. unpaid, pure sales, on-site only in another city" />
          </label>
          <label style={{ fontSize: 13 }}>Biggest wins <span className="faint">— optional, strengthens tailoring</span>
            <textarea className="input" style={{ width: '100%', minHeight: 70 }} value={wins} onChange={(e) => setWins(e.target.value)}
              placeholder="e.g. Cut API latency 60%; shipped a payments feature used by 40k users" />
          </label>
        </div>
        <div className="row" style={{ marginTop: 14, gap: 8, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={saveGuided} disabled={saving}>
            {saving ? <span className="spinner" /> : '✓'} Save &amp; make ready
          </button>
          {status?.setupReady && <span className="chip" style={{ background: '#34d39922', color: '#34d399' }}>ready to scrape</span>}
        </div>
      </div>

      {/* Step 3 — optional AI polish */}
      <div className="card card-pad">
        <h3 style={{ marginTop: 0 }}>3 · Polish with AI <span className="faint" style={{ fontSize: 13, fontWeight: 400 }}>(optional)</span></h3>
        <p className="faint" style={{ fontSize: 13, marginTop: 0 }}>
          Turns your profile + resume into richer tailoring documents (behavioral profile, writing style,
          STAR interview stories, a tailored CV template). Needed for the best CV/cover-letter tailoring,
          not for finding jobs.
        </p>
        {!status?.aiEnabled ? (
          <div style={{ fontSize: 13, color: '#fbbf24' }}>
            ⚠ No AI provider is configured on the server, so this step is disabled. Set a free Groq or Gemini
            key in the backend environment (<code>JOBPILOT_GROQ_API_KEY</code>) to enable it. Steps 1–2 work without it.
          </div>
        ) : (
          <button className="btn" onClick={enhance} disabled={enhancing}>
            {enhancing ? <span className="spinner" /> : '✨'} Generate AI documents
          </button>
        )}
      </div>

      {/* Advanced — raw document editors */}
      <div className="card card-pad">
        <button className="btn btn-sm" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? '▾' : '▸'} Advanced — edit the 8 documents directly
        </button>
        {showAdvanced && (
          <>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
              {Object.entries(DOC_LABELS).map(([k, label]) => (
                <button key={k} className="btn btn-sm" onClick={() => openEditor(k)} style={{ opacity: checklist[k] ? 1 : 0.55 }}>
                  {checklist[k] ? '✓' : '○'} {label}
                </button>
              ))}
            </div>
            {openDoc && (
              <div>
                <textarea className="input" style={{ width: '100%', minHeight: 240, fontFamily: 'monospace', fontSize: 12 }}
                  value={draft} onChange={(e) => setDraft(e.target.value)} />
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => saveDoc(openDoc)}>Save {DOC_LABELS[openDoc]}</button>
                  <button className="btn btn-sm" onClick={() => setOpenDoc('')}>Close</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---- Jobs (scrape + rank + apply) -------------------------------------------

function JobsTab({ status, onChange, onApplied }:
  { status: EngineStatus | null; onChange: () => void; onApplied: () => void }) {
  const toast = useToast();
  const [jobs, setJobs] = useState<EngineJob[]>([]);
  const [filter, setFilter] = useState('ranked');
  const [applyingId, setApplyingId] = useState('');

  const load = useCallback(() => {
    api.engineJobs(filter === 'all' ? undefined : filter).then(setJobs).catch(() => {});
  }, [filter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (status?.scrapeRunning || status?.rankRunning) { const t = setInterval(load, 4000); return () => clearInterval(t); }
  }, [status?.scrapeRunning, status?.rankRunning, load]);

  const scrape = async () => {
    try { await api.engineScrape(); toast('Scrape started — searching LinkedIn…', 'success'); onChange(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const rank = async () => {
    try { await api.engineRank(); toast('Ranking started…', 'success'); onChange(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const apply = async (j: EngineJob) => {
    setApplyingId(j.id);
    try {
      await api.engineApply({ jobId: j.id });
      toast(`Applying to ${j.title} — pipeline started`, 'success');
      onApplied();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setApplyingId(''); }
  };
  const dismiss = async (j: EngineJob) => {
    try { await api.engineDismissJob(j.id); setJobs((xs) => xs.filter((x) => x.id !== j.id)); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const sc = status?.jobStatusCounts ?? {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card card-pad row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={scrape} disabled={status?.scrapeRunning || !status?.setupReady}
          title={status?.setupReady ? 'Search LinkedIn from your saved queries' : 'Run Setup first'}>
          {status?.scrapeRunning ? <span className="spinner" /> : '🔎'} Scrape LinkedIn
        </button>
        <button className="btn" onClick={rank} disabled={status?.rankRunning || !status?.aiEnabled}>
          {status?.rankRunning ? <span className="spinner" /> : '⚖'} Rank new
        </button>
        <span className="faint" style={{ fontSize: 12.5 }}>
          {sc.new ?? 0} new · {sc.shortlisted ?? 0} shortlisted · {sc.ranked ?? 0} ranked ·
          {' '}{sc.applied ?? 0} applied · {sc.expired ?? 0} expired
        </span>
        <select className="input" style={{ marginLeft: 'auto', maxWidth: 180 }} value={filter}
          onChange={(e) => setFilter(e.target.value)}>
          <option value="ranked">Ranked (best first)</option>
          <option value="shortlisted">Shortlisted</option>
          <option value="new">New (unranked)</option>
          <option value="applied">Applied</option>
          <option value="expired">Expired</option>
          <option value="all">All</option>
        </select>
      </div>

      {jobs.length === 0 ? (
        <div className="card card-pad empty">
          <div className="big">🔎</div>
          {status?.setupReady ? 'No jobs yet. Scrape LinkedIn, then Rank.' : 'Run Setup first, then Scrape LinkedIn.'}
        </div>
      ) : jobs.map((j) => (
        <div key={j.id} className="card card-pad">
          <div className="row" style={{ justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <a href={j.url} target="_blank" rel="noreferrer" className="pick-title" style={{ textDecoration: 'none' }}>
                {j.title} ↗
              </a>
              <div className="job-company" style={{ marginTop: 4, fontSize: 13 }}>
                {typeof j.fitScore === 'number' && j.verdict &&
                  <Chip text={`${j.verdict} ${j.fitScore}/100`} color={VERDICT_COLOR[j.verdict] ?? '#7d8595'} />}
                {j.urgent && <> <Chip text="urgent" color="#f59e0b" /></>}
                {j.dealBreaker && <> <Chip text="deal-breaker" color="#f87171" /></>}
                {j.company && <> · {j.company}</>}{j.location && <> · {j.location}</>}
                {j.postedAt && <> · {j.postedAt}</>}
              </div>
              {j.strengths && <div style={{ fontSize: 12.5, marginTop: 6, color: '#34d399' }}>💪 {j.strengths}</div>}
              {j.gaps && <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>🕳 {j.gaps}</div>}
              {j.dealBreaker && <div style={{ fontSize: 12.5, marginTop: 2, color: '#f87171' }}>⛔ {j.dealBreaker}</div>}
            </div>
            <div className="row" style={{ gap: 6, flexShrink: 0 }}>
              {j.status !== 'applied' && j.status !== 'applying' && (
                <button className="btn btn-primary btn-sm" onClick={() => apply(j)} disabled={applyingId === j.id || !status?.setupReady}>
                  {applyingId === j.id ? <span className="spinner" /> : '✍'} Apply
                </button>
              )}
              {j.status === 'applied' && <Chip text="applied ✓" color="#16a34a" />}
              {j.status === 'applying' && <Chip text="applying…" color="#818cf8" />}
              <button className="btn btn-ghost btn-sm" onClick={() => dismiss(j)}>✕</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Applications -----------------------------------------------------------

type StageLogEntry = { stage: string; at: string; note: string };

function ApplicationsTab() {
  const toast = useToast();
  const [apps, setApps] = useState<EngineApplicationSummary[]>([]);
  const [openId, setOpenId] = useState('');
  const [detail, setDetail] = useState<EngineApplication | null>(null);

  const load = useCallback(() => { api.engineApplications().then(setApps).catch(() => {}); }, []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const open = (id: string) => {
    if (openId === id) { setOpenId(''); setDetail(null); return; }
    setOpenId(id); setDetail(null);
    api.engineApplication(id).then(setDetail).catch((e) => toast((e as Error).message, 'error'));
  };

  const inFlight = (s: string) => !['ready', 'submitted', 'failed', 'vetoed'].includes(s);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {apps.length === 0 ? (
        <div className="card card-pad empty"><div className="big">✍</div>No applications yet — Apply to a job from the Jobs tab.</div>
      ) : apps.map((a) => (
        <div key={a.id} className="card card-pad" style={{ cursor: 'pointer' }} onClick={() => open(a.id)}>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <span className="pick-title">{a.postingTitle || 'Application'}</span>
              <div className="job-company" style={{ marginTop: 4, fontSize: 13 }}>
                <Chip text={inFlight(a.stage) ? `${a.stage}…` : a.stage} color={STAGE_COLOR[a.stage] ?? '#7d8595'} />
                {a.verdict && typeof a.fitScore === 'number' &&
                  <> <Chip text={`${a.verdict} ${a.fitScore}/100`} color={VERDICT_COLOR[a.verdict] ?? '#7d8595'} /></>}
                {a.outcome && <> <Chip text={a.outcome} color="#60a5fa" /></>}
                {a.postingCompany && <> · {a.postingCompany}</>}
              </div>
              {a.error && <div style={{ fontSize: 12.5, marginTop: 4, color: '#f87171' }}>{a.error}</div>}
            </div>
            <div className="faint" style={{ fontSize: 12, textAlign: 'right', flexShrink: 0 }}>
              {inFlight(a.stage) && <span className="spinner" style={{ marginRight: 6 }} />}
              {fmtDate(a.updatedAt)}
            </div>
          </div>
          {openId === a.id && (
            <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 12, borderTop: '1px solid var(--border,#1f2530)', paddingTop: 10 }}>
              {!detail ? <span className="spinner" /> : <AppDetail d={detail} onChange={load} />}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AppDetail({ d, onChange }: { d: EngineApplication; onChange: () => void }) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [show, setShow] = useState<'letter' | 'review' | 'cv' | 'ats' | ''>('');
  const log: StageLogEntry[] = safeParse(d.stageLog, []);
  const ev = safeParse<Record<string, unknown>>(d.evaluation, {});
  const ats = safeParse<Record<string, unknown>>(d.atsReport, {});

  const download = async (kind: 'cv' | 'cover', name: string) => {
    try {
      const blob = await api.enginePdf(d.id, kind);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast(`PDF unavailable (${(e as Error).message})`, 'error'); }
  };
  const submit = async () => {
    try { await api.engineSubmit(d.id, email); toast('Emailed ✓', 'success'); onChange(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const outcome = async (o: string) => {
    try { await api.engineOutcome(d.id, o, ''); toast(`Outcome: ${o}`, 'success'); onChange(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ marginBottom: 10 }}>
        <b>Timeline</b>
        {log.map((e, i) => (
          <div key={i} className="row" style={{ gap: 8, padding: '2px 0', flexWrap: 'wrap' }}>
            <Chip text={e.stage} color={STAGE_COLOR[e.stage] ?? '#7d8595'} />
            <span className="faint" style={{ fontSize: 12 }}>{fmtDate(e.at)}</span>
            <span>{e.note}</span>
          </div>
        ))}
      </div>

      {typeof ev.overall === 'number' && (
        <div style={{ marginBottom: 10 }}>
          <b>Fit</b>{' '}
          <Chip text={`${ev.verdict ?? ''} ${ev.overall}/100`} color={VERDICT_COLOR[String(ev.verdict)] ?? '#7d8595'} />
          {Array.isArray(ev.strengths) && <div style={{ marginTop: 4 }}>💪 {(ev.strengths as string[]).join(' · ')}</div>}
          {Array.isArray(ev.gaps) && <div className="faint" style={{ marginTop: 2 }}>🕳 {(ev.gaps as string[]).join(' · ')}</div>}
        </div>
      )}

      {typeof ats.requiredCoveragePct === 'number' && (
        <div style={{ marginBottom: 10 }}>
          <b>ATS verification</b>{' '}
          <Chip text={`${ats.requiredCoveragePct}% required keywords`}
            color={(ats.requiredCoveragePct as number) >= 70 ? '#34d399' : (ats.requiredCoveragePct as number) >= 40 ? '#fbbf24' : '#f87171'} />
          {' '}<Chip text={ats.hasEmail ? 'contact readable' : 'contact missing'} color={ats.hasEmail ? '#34d399' : '#f87171'} />
          {ats.garbled ? <> <Chip text="garbled text" color="#f87171" /></> : null}
          {Array.isArray(ats.requiredMissingGap) && (ats.requiredMissingGap as string[]).length > 0 &&
            <div className="faint" style={{ marginTop: 4 }}>✕ honest gaps (never stuffed): {(ats.requiredMissingGap as string[]).join(', ')}</div>}
          {typeof d.cvPages === 'number' && <div className="faint" style={{ marginTop: 2 }}>CV {d.cvPages} page(s){d.cutReport ? ' · relevance-cut applied' : ''}</div>}
        </div>
      )}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        {d.coverLatex && <button className="btn btn-sm" onClick={() => setShow(show === 'letter' ? '' : 'letter')}>✉ Letter</button>}
        {d.reviewerFeedback && <button className="btn btn-sm" onClick={() => setShow(show === 'review' ? '' : 'review')}>🧐 Reviewer</button>}
        {d.cvLatex && <button className="btn btn-sm" onClick={() => setShow(show === 'cv' ? '' : 'cv')}>📐 CV LaTeX</button>}
        {d.cvPages ? <button className="btn btn-sm" onClick={() => download('cv', 'cv.pdf')}>⬇ CV PDF</button> : null}
        {d.coverPages ? <button className="btn btn-sm" onClick={() => download('cover', 'cover-letter.pdf')}>⬇ Letter PDF</button> : null}
      </div>
      {show === 'letter' && <pre style={preStyle}>{d.coverLatex}</pre>}
      {show === 'review' && <pre style={preStyle}>{d.reviewerFeedback}{d.revisionNotes ? `\n\n— ${d.revisionNotes}` : ''}</pre>}
      {show === 'cv' && <pre style={{ ...preStyle, maxHeight: 320, overflow: 'auto' }}>{d.cvLatex}</pre>}

      {d.stage === 'ready' && (
        <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" style={{ maxWidth: 240 }} placeholder="recruiter@company.com"
            value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={!email}>Send by email</button>
          <button className="btn btn-sm" onClick={() => outcome('applied')}>Mark applied (I submitted)</button>
        </div>
      )}
      {(d.stage === 'submitted' || d.outcome) && (
        <div className="row" style={{ gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          <span className="faint" style={{ fontSize: 12, alignSelf: 'center' }}>Outcome:</span>
          {['interview_1', 'interview_2', 'offer', 'rejected', 'withdrawn'].map((o) => (
            <button key={o} className="btn btn-sm" onClick={() => outcome(o)}>{o.replace('_', ' ')}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Interview --------------------------------------------------------------

function InterviewTab() {
  const toast = useToast();
  const [apps, setApps] = useState<EngineApplicationSummary[]>([]);
  const [packs, setPacks] = useState<EngineInterview[]>([]);
  const [appId, setAppId] = useState('');
  const [stage, setStage] = useState('first interview');
  const [running, setRunning] = useState(false);

  const load = useCallback(() => {
    api.engineApplications().then((a) => setApps(a.filter((x) => x.outcome || x.stage === 'submitted' || x.stage === 'ready'))).catch(() => {});
    api.engineInterviews().then(setPacks).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const gen = async () => {
    if (!appId) { toast('Pick an application first', 'error'); return; }
    setRunning(true);
    try { await api.engineInterview(appId, stage); toast('Prep pack ready ✓', 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setRunning(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card card-pad">
        <h3 style={{ marginTop: 0 }}>Interview prep</h3>
        <p className="faint" style={{ fontSize: 13, marginTop: 0 }}>
          Built from that application's own archive — the posting, the exact CV &amp; letter they read, and your
          STAR examples. Gaps get honest bridge answers, never invented experience.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="input" style={{ maxWidth: 300 }} value={appId} onChange={(e) => setAppId(e.target.value)}>
            <option value="">Select an application…</option>
            {apps.map((a) => <option key={a.id} value={a.id}>{a.postingTitle} @ {a.postingCompany}</option>)}
          </select>
          <input className="input" style={{ maxWidth: 180 }} value={stage} onChange={(e) => setStage(e.target.value)} />
          <button className="btn btn-primary btn-sm" onClick={gen} disabled={running}>
            {running ? <span className="spinner" /> : '🎯'} Build pack
          </button>
        </div>
      </div>
      {packs.map((p) => (
        <div key={p.id} className="card card-pad">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>{p.stageLabel}</b><span className="faint" style={{ fontSize: 12 }}>{fmtDate(p.createdAt)}</span>
          </div>
          <pre style={{ ...preStyle, marginTop: 8 }}>{p.packMd}</pre>
        </div>
      ))}
    </div>
  );
}

// ---- Upskill ----------------------------------------------------------------

function UpskillTab() {
  const toast = useToast();
  const [reports, setReports] = useState<EngineUpskill[]>([]);
  const [running, setRunning] = useState(false);

  const load = useCallback(() => { api.engineUpskills().then(setReports).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  const run = async () => {
    setRunning(true);
    try { await api.engineUpskillRun(); toast('Upskill report ready ✓', 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setRunning(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card card-pad row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ margin: 0 }}>Skill gap analysis</h3>
          <span className="faint" style={{ fontSize: 13 }}>Compares your profile against the postings you've tracked.</span>
        </div>
        <button className="btn btn-primary btn-sm" onClick={run} disabled={running}>
          {running ? <span className="spinner" /> : '📊'} Run analysis
        </button>
      </div>
      {reports.map((r) => {
        const heat = safeParse<{ heatmap?: { skill: string; demand: number; have: boolean }[] }>(r.heatmap, {});
        return (
          <div key={r.id} className="card card-pad">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>Report</b><span className="faint" style={{ fontSize: 12 }}>{fmtDate(r.createdAt)}</span>
            </div>
            {heat.heatmap && (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {heat.heatmap.map((h, i) => (
                  <Chip key={i} text={`${h.skill} ·${h.demand}`} color={h.have ? '#34d399' : '#f59e0b'} />
                ))}
              </div>
            )}
            <pre style={{ ...preStyle, marginTop: 8 }}>{r.reportMd}</pre>
          </div>
        );
      })}
    </div>
  );
}

// ---- shared ------------------------------------------------------------------

const preStyle: React.CSSProperties = { whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12.5, marginTop: 6 };

function safeParse<T>(s: string | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
