import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type {
  EngineApplication, EngineApplicationSummary, EngineDoc, EngineInterview, EngineJob,
  EnginePrefill, EngineProfile, EngineStatus, EngineUpskill,
} from '../types';
import { fmtDate, useToast } from '../lib/ui';
import { Icon } from '../components/Icon';
import { JobProfileEditor } from '../components/JobProfileEditor';
import { RunControls, PortalMetrics, ActivityFeed, ScheduleEditor } from '../components/AutomationPanels';

/**
 * Auto Apply — a clean-room replica of the ai-job-search framework, built as its own
 * component (backend package com.jobpilot.engine, tables engine_*, API /api/engine/**).
 * It shares only generic plumbing (AI, LaTeX compile, PDF, mail) with the rest of the app.
 * Flow: Setup → Scrape → Rank → Apply (draft → review → revise → compile → ATS verify)
 *       → Outcome → Interview → Upskill.
 */

type Tab = 'setup' | 'jobs' | 'applications' | 'interview' | 'upskill' | 'activity' | 'schedule';

// Semantic, theme-aware tones (see .tone-* in styles.css) — readable in light + dark.
const VERDICT_TONE: Record<string, string> = {
  strong: 'green', good: 'blue', moderate: 'amber', weak: 'amber', poor: 'red',
};
const STAGE_TONE: Record<string, string> = {
  parsing: 'slate', evaluating: 'blue', drafting: 'purple', reviewing: 'purple',
  revising: 'indigo', compiling: 'blue', verifying: 'green',
  ready: 'amber', submitted: 'green', failed: 'red', vetoed: 'amber',
};
// Human labels — "ready" confused people ("is it applied?"). It means the tailored CV +
// cover are BUILT and waiting to be sent (by email) or applied on the portal by the Agent.
const STAGE_LABEL: Record<string, string> = {
  parsing: 'Reading posting', evaluating: 'Scoring fit', drafting: 'Tailoring CV + letter',
  reviewing: 'Reviewing', revising: 'Revising', compiling: 'Building PDFs',
  verifying: 'ATS check', ready: 'Ready to send', submitted: 'Sent', failed: 'Failed',
  vetoed: 'Vetoed',
};

// The engine's internal steering documents (from the ai-job-search framework). The CV and
// cover TEMPLATES are intentionally absent: the engine now tailors your BASE résumé from
// the Resumes section and writes covers via your saved cover-letter template.
const DOC_LABELS: Record<string, string> = {
  candidate: 'Candidate profile', behavioral: 'Behavioral profile',
  writingStyle: 'Writing style', evaluation: 'Evaluation lens',
  interviewPrep: 'Interview prep', searchQueries: 'Search queries (JSON)',
};
const DOC_FIELD: Record<string, keyof EngineProfile> = {
  candidate: 'candidateMd', behavioral: 'behavioralMd', writingStyle: 'writingStyleMd',
  evaluation: 'evaluationMd', interviewPrep: 'interviewPrepMd', searchQueries: 'searchQueries',
};
// What each steering document steers — shown in the Advanced section so it isn't a mystery.
const DOC_HELP: Record<string, string> = {
  candidate: 'The facts the AI is allowed to use about you (source of truth for tailoring).',
  behavioral: 'How you work & what you value — used for culture-fit scoring.',
  writingStyle: 'Tone rules the AI follows when writing your documents.',
  evaluation: 'Your goals, must-haves and deal-breakers — the lens jobs are scored through.',
  interviewPrep: 'Your STAR stories & talking points — used to build interview packs.',
  searchQueries: 'The exact keywords + locations the scraper searches (JSON).',
};

function Chip({ text, tone = 'indigo' }: { text: string; tone?: string }) {
  return <span className={`tone tone-${tone}`}>{text}</span>;
}

/** A prominent, at-a-glance fit score with a coloured ring (verdict-toned). */
function FitScore({ score, verdict }: { score?: number; verdict?: string }) {
  if (typeof score !== 'number') return null;
  const tone = VERDICT_TONE[verdict ?? ''] ?? 'slate';
  return (
    <div className={`fit-score tone-${tone}`} title={verdict ? `${verdict} match` : 'fit score'}>
      <span className="fit-num">{score}</span>
      <span className="fit-cap">{verdict || 'fit'}</span>
    </div>
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
            {status && !status.aiEnabled && <Chip text="AI off" tone="red" />}
            {status?.setupReady && <> <Chip text="setup ready" tone="green" /></>}
          </h1>
          <div className="page-sub">
            One automation, on a schedule: it finds jobs on <b>LinkedIn</b> &amp; <b>Indeed</b>, scores
            your fit, Easy-Applies, scans hiring posts for HR emails, sends tailored emails +
            connection requests — and mails you anything it can’t apply to itself. Watch it live any time.
          </div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {busy && <span className="row" style={{ gap: 6, fontSize: 13 }}><span className="spinner" />{status?.scrapeProgress || status?.rankProgress || 'Working…'}</span>}
          <RunControls />
        </div>
      </div>

      {status && !status.aiEnabled && (
        <div className="card card-pad" style={{ marginBottom: 14, borderColor: 'var(--amber)', fontSize: 13, display: 'flex', gap: 9, alignItems: 'center' }}>
          <Icon name="alert" size={16} className="t-amber" style={{ flex: 'none' }} /> No AI provider configured — Setup, Rank and Apply need one. Add it in Settings → AI model.
        </div>
      )}

      {status && <AutopilotBanner status={status} onChange={loadStatus} />}

      <div className="tabs">
        {([
          ['setup', 'gear', 'Setup', ''],
          ['jobs', 'compass', 'Jobs', count(status?.jobStatusCounts)],
          ['applications', 'clipboard', 'Applications', count(status?.appStageCounts)],
          ['interview', 'target', 'Interview', ''],
          ['upskill', 'chart', 'Upskill', ''],
          ['activity', 'live', 'Activity', ''],
          ['schedule', 'clock', 'Schedule', ''],
        ] as [Tab, string, string, string][]).map(([t, ico, label, n]) => (
          <div key={t} className={`tab meta-item ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            <Icon name={ico} size={14} /> {label}{n && <span className="tab-count">{n.replace(/[()\s]/g, '')}</span>}
          </div>
        ))}
      </div>

      {tab === 'setup' && <SetupTab status={status} onChange={loadStatus} />}
      {tab === 'jobs' && <JobsTab status={status} onChange={loadStatus} onApplied={() => setTab('applications')} />}
      {tab === 'applications' && <ApplicationsTab />}
      {tab === 'interview' && <InterviewTab />}
      {tab === 'upskill' && <UpskillTab />}
      {tab === 'activity' && <ActivityFeed />}
      {tab === 'schedule' && <ScheduleEditor />}
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
    <div className="card card-pad" style={{ marginBottom: 14, borderColor: a.enabled ? 'var(--green)' : undefined }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="bot" size={17} /> Autopilot{' '}
            <Chip text={a.enabled ? (a.running ? 'running now' : 'ON · daily 09:30') : 'off'}
              tone={a.enabled ? (a.running ? 'blue' : 'green') : 'slate'} />
          </div>
          <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>
            Runs the whole cycle by itself every day — scrape → rank → apply the top {a.dailyCap} best-fit jobs (fit ≥ {a.minFit}).
            {a.lastRunSummary ? ` Last run: ${a.lastRunSummary}` : ' Not run yet.'}
          </div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={runNow} disabled={busy || a.running || !status.setupReady}
            title={status.setupReady ? 'Run the full cycle now' : 'Finish Setup first'}>
            {a.running ? <span className="spinner" /> : <Icon name="play" size={13} />} Run now
          </button>
          <button className="btn btn-sm" onClick={() => setOpen((v) => !v)}><Icon name="gear" size={13} /> Limits</button>
          <button className={`btn btn-sm ${a.enabled ? 'btn-danger-solid' : 'btn-primary'}`} onClick={toggle}
            disabled={busy || !status.setupReady}>
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
        <div className="step-head">
          <span className="step-num">1</span>
          <div><div className="step-title">Your details</div><div className="step-sub">Pulled from your Profile — the engine uses these for matching &amp; CV tailoring.</div></div>
        </div>
        {me ? (
          <>
            <div className="kv-tiles">
              <div className="kv-tile"><span className="kv-k">Name</span><span className="kv-v">{me.fullName || <em className="faint">add in Profile</em>}</span></div>
              <div className="kv-tile"><span className="kv-k">Email</span><span className="kv-v">{me.email || '—'}</span></div>
              <div className="kv-tile"><span className="kv-k">Phone</span><span className="kv-v">{me.phone || '—'}</span></div>
              <div className="kv-tile"><span className="kv-k">Current role</span><span className="kv-v">{me.currentTitle || '—'}{me.currentCompany ? ` @ ${me.currentCompany}` : ''}</span></div>
              <div className="kv-tile"><span className="kv-k">Experience</span><span className="kv-v">{me.yearsExperience || '—'}</span></div>
              <div className="kv-tile"><span className="kv-k">Resume</span><span className="kv-v">{me.hasResume ? <Chip text="uploaded" tone="green" /> : <Chip text="none" tone="amber" />}</span></div>
            </div>
            {me.skills?.length > 0 && (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
                {me.skills.slice(0, 16).map((s) => <span key={s} className="chip">{s}</span>)}
              </div>
            )}
            <div className="faint" style={{ fontSize: 12, marginTop: 12 }}>
              These come from your <a href="/profile">Profile</a> — edit there. {!me.hasResume && 'Upload a resume in Profile to enable AI CV tailoring.'}
            </div>
          </>
        ) : <span className="spinner" />}
      </div>

      {/* Step 2 — what you're looking for (no AI needed) */}
      <div className="card card-pad">
        <div className="step-head">
          <span className="step-num">2</span>
          <div><div className="step-title">What you're looking for</div><div className="step-sub">All the engine needs to find &amp; rank jobs — no AI required. Separate entries with commas.</div></div>
        </div>
        <p className="faint" style={{ fontSize: 13, marginTop: 0, display: 'none' }}>
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
            {saving ? <span className="spinner" /> : <Icon name="check" size={14} />} Save &amp; make ready
          </button>
          {status?.setupReady && <Chip text="ready to scrape" tone="green" />}
        </div>
      </div>

      {/* Job profile — desired roles, projects, achievements (owner wanted it HERE, not in Profile) */}
      <JobProfileEditor />

      {/* Step 3 — optional AI polish */}
      <div className="card card-pad">
        <div className="step-head">
          <span className="step-num">3</span>
          <div><div className="step-title">Polish with AI <span className="faint" style={{ fontWeight: 400 }}>· optional</span></div><div className="step-sub">Richer tailoring documents for the best CV/cover-letter results — not needed to find jobs.</div></div>
        </div>
        <p className="faint" style={{ fontSize: 13, marginTop: 0, display: 'none' }}>
          Turns your profile + resume into richer tailoring documents (behavioral profile, writing style,
          STAR interview stories, a tailored CV template). Needed for the best CV/cover-letter tailoring,
          not for finding jobs.
        </p>
        {!status?.aiEnabled ? (
          <div style={{ fontSize: 13, color: '#fbbf24', display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <Icon name="alert" size={14} style={{ flex: 'none', transform: 'translateY(2px)' }} /><span>No AI provider is configured on the server, so this step is disabled. Set a free Groq or Gemini
            key in the backend environment (<code>JOBPILOT_GROQ_API_KEY</code>) to enable it. Steps 1–2 work without it.</span>
          </div>
        ) : (
          <button className="btn" onClick={enhance} disabled={enhancing}>
            {enhancing ? <span className="spinner" /> : <Icon name="sparkles" size={14} />} Generate AI documents
          </button>
        )}
      </div>

      {/* Advanced — raw document editors */}
      <div className="card card-pad">
        <button className="btn btn-sm" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? '▾' : '▸'} Advanced — the engine's steering documents
        </button>
        {showAdvanced && (
          <>
            <p className="faint" style={{ fontSize: 12.5, margin: '10px 0 4px', lineHeight: 1.6 }}>
              These are the internal notes the AI reads before evaluating or writing anything —
              Setup and "Generate AI documents" fill them for you. Edit one only when you want to
              override what the AI believes (e.g. sharpen your deal-breakers). A ✓ means it has
              content. Your CV/cover templates are NOT here — the engine uses your base résumé
              (Resumes) and your cover-letter template (Profile).
            </p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
              {Object.entries(DOC_LABELS).map(([k, label]) => (
                <button key={k} className="btn btn-sm" onClick={() => openEditor(k)}
                  title={DOC_HELP[k]} style={{ opacity: checklist[k] ? 1 : 0.55 }}>
                  <Icon name={checklist[k] ? 'check' : 'circle'} size={13} /> {label}
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
      <div className="section-title" style={{ marginBottom: 0 }}><Icon name="chart" size={15} /> Per-portal — this run</div>
      <PortalMetrics />
      <div className="section-title" style={{ margin: '6px 0 0' }}><Icon name="compass" size={15} /> Ranked matches (Engine)</div>
      <div className="card card-pad row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={scrape} disabled={status?.scrapeRunning || !status?.setupReady}
          title={status?.setupReady ? 'Search LinkedIn from your saved queries' : 'Run Setup first'}>
          {status?.scrapeRunning ? <span className="spinner" /> : <Icon name="search" size={14} />} Scrape LinkedIn
        </button>
        <button className="btn" onClick={rank} disabled={status?.rankRunning || !status?.aiEnabled}>
          {status?.rankRunning ? <span className="spinner" /> : <Icon name="scale" size={14} />} Rank new
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
          <div className="big"><Icon name="search" size={34} /></div>
          {status?.setupReady ? 'No jobs yet. Scrape LinkedIn, then Rank.' : 'Run Setup first, then Scrape LinkedIn.'}
        </div>
      ) : jobs.map((j) => (
        <div key={j.id} className="card card-pad eng-job">
          <FitScore score={j.fitScore} verdict={j.verdict} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
              <a href={j.url} target="_blank" rel="noreferrer" className="pick-title" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                {j.title} <Icon name="external" size={13} />
              </a>
              <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                {j.status !== 'applied' && j.status !== 'applying' && (
                  <button className="btn btn-primary btn-sm" onClick={() => apply(j)} disabled={applyingId === j.id || !status?.setupReady}>
                    {applyingId === j.id ? <span className="spinner" /> : <Icon name="pen" size={13} />} Apply
                  </button>
                )}
                {j.status === 'applied' && <Chip text="applied" tone="green" />}
                {j.status === 'applying' && <Chip text="applying…" tone="indigo" />}
                <button className="btn btn-ghost btn-sm" onClick={() => dismiss(j)} title="Dismiss"><Icon name="x" size={14} /></button>
              </div>
            </div>
            <div className="job-meta">
              {j.company && <span className="meta-item"><Icon name="clipboard" size={12} /> {j.company}</span>}
              {j.location && <span className="meta-item"><Icon name="compass" size={12} /> {j.location}</span>}
              {j.postedAt && <span className="meta-item"><Icon name="clock" size={12} /> {j.postedAt}</span>}
              {j.urgent && <Chip text="urgent" tone="amber" />}
              {j.dealBreaker && <Chip text="deal-breaker" tone="red" />}
            </div>
            {j.strengths && <div className="t-green" style={{ fontSize: 12.5, marginTop: 8, display: 'flex', gap: 6, alignItems: 'baseline' }}><Icon name="check" size={13} style={{ flex: 'none', transform: 'translateY(2px)' }} /><span>{j.strengths}</span></div>}
            {j.gaps && <div className="faint" style={{ fontSize: 12.5, marginTop: 3, display: 'flex', gap: 6, alignItems: 'baseline' }}><Icon name="gap" size={13} style={{ flex: 'none', transform: 'translateY(2px)' }} /><span>{j.gaps}</span></div>}
            {j.dealBreaker && <div className="t-red" style={{ fontSize: 12.5, marginTop: 3, display: 'flex', gap: 6, alignItems: 'baseline' }}><Icon name="ban" size={13} style={{ flex: 'none', transform: 'translateY(2px)' }} /><span>{j.dealBreaker}</span></div>}
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
      <div className="section-title" style={{ marginBottom: 0 }}><Icon name="chart" size={15} /> Applied — per portal</div>
      <PortalMetrics kind="applied" />
      <div className="section-title" style={{ margin: '6px 0 0' }}><Icon name="clipboard" size={15} /> Application packages (Engine)</div>
      <div className="card card-pad" style={{ fontSize: 12.5, display: 'flex', gap: 9, alignItems: 'flex-start' }}>
        <Icon name="alert" size={15} className="t-amber" style={{ flex: 'none', transform: 'translateY(1px)' }} />
        <span className="faint">
          <b className="t-amber">Ready to send</b> means the tailored CV + cover letter are built and verified —
          the Engine has done its job. It's <b>not submitted yet</b>: open one and hit <b>Send by email</b> for
          email-apply roles, or let the <b>Agent</b> apply it on the portal (Easy Apply). Only <b>Sent</b> means it went out.
        </span>
      </div>
      {apps.length === 0 ? (
        <div className="card card-pad empty"><div className="big"><Icon name="pen" size={34} /></div>No applications yet — Apply to a job from the Jobs tab.</div>
      ) : apps.map((a) => (
        <div key={a.id} className={`card card-pad card-click ${openId === a.id ? 'open' : ''}`} onClick={() => open(a.id)}>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <span className="pick-title">{a.postingTitle || 'Application'}</span>
              <div className="job-company" style={{ marginTop: 4, fontSize: 13 }}>
                <Chip text={inFlight(a.stage) ? `${STAGE_LABEL[a.stage] ?? a.stage}…` : (STAGE_LABEL[a.stage] ?? a.stage)} tone={STAGE_TONE[a.stage] ?? 'slate'} />
                {a.verdict && typeof a.fitScore === 'number' &&
                  <> <Chip text={`${a.verdict} ${a.fitScore}/100`} tone={VERDICT_TONE[a.verdict] ?? 'slate'} /></>}
                {a.outcome && <> <Chip text={a.outcome} tone="blue" /></>}
                {a.postingCompany && <> · {a.postingCompany}</>}
              </div>
              {a.error && <div className="t-red" style={{ fontSize: 12.5, marginTop: 4 }}>{a.error}</div>}
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
            <Chip text={e.stage} tone={STAGE_TONE[e.stage] ?? 'slate'} />
            <span className="faint" style={{ fontSize: 12 }}>{fmtDate(e.at)}</span>
            <span>{e.note}</span>
          </div>
        ))}
      </div>

      {typeof ev.overall === 'number' && (
        <div style={{ marginBottom: 10 }}>
          <b>Fit</b>{' '}
          <Chip text={`${ev.verdict ?? ''} ${ev.overall}/100`} tone={VERDICT_TONE[String(ev.verdict)] ?? 'slate'} />
          {Array.isArray(ev.strengths) && <div className="t-green" style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'baseline' }}><Icon name="check" size={13} style={{ flex: 'none', transform: 'translateY(2px)' }} /><span>{(ev.strengths as string[]).join(' · ')}</span></div>}
          {Array.isArray(ev.gaps) && <div className="faint" style={{ marginTop: 2, display: 'flex', gap: 6, alignItems: 'baseline' }}><Icon name="gap" size={13} style={{ flex: 'none', transform: 'translateY(2px)' }} /><span>{(ev.gaps as string[]).join(' · ')}</span></div>}
        </div>
      )}

      {typeof ats.requiredCoveragePct === 'number' && (
        <div style={{ marginBottom: 10 }}>
          <b>ATS verification</b>{' '}
          <Chip text={`${ats.requiredCoveragePct}% required keywords`}
            tone={(ats.requiredCoveragePct as number) >= 70 ? 'green' : (ats.requiredCoveragePct as number) >= 40 ? 'amber' : 'red'} />
          {' '}<Chip text={ats.hasEmail ? 'contact readable' : 'contact missing'} tone={ats.hasEmail ? 'green' : 'red'} />
          {ats.garbled ? <> <Chip text="garbled text" tone="red" /></> : null}
          {Array.isArray(ats.requiredMissingGap) && (ats.requiredMissingGap as string[]).length > 0 &&
            <div className="faint" style={{ marginTop: 4 }}>Honest gaps (never stuffed): {(ats.requiredMissingGap as string[]).join(', ')}</div>}
          {typeof d.cvPages === 'number' && <div className="faint" style={{ marginTop: 2 }}>CV {d.cvPages} page(s){d.cutReport ? ' · relevance-cut applied' : ''}</div>}
        </div>
      )}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        {d.coverLatex && <button className="btn btn-sm" onClick={() => setShow(show === 'letter' ? '' : 'letter')}><Icon name="mail" size={13} /> Letter</button>}
        {d.reviewerFeedback && <button className="btn btn-sm" onClick={() => setShow(show === 'review' ? '' : 'review')}><Icon name="search" size={13} /> Reviewer</button>}
        {d.cvLatex && <button className="btn btn-sm" onClick={() => setShow(show === 'cv' ? '' : 'cv')}><Icon name="file" size={13} /> CV source</button>}
        {d.cvPages ? <button className="btn btn-sm" onClick={() => download('cv', 'cv.pdf')}><Icon name="download" size={13} /> CV PDF</button> : null}
        {d.coverPages ? <button className="btn btn-sm" onClick={() => download('cover', 'cover-letter.pdf')}><Icon name="download" size={13} /> Letter PDF</button> : null}
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
            {running ? <span className="spinner" /> : <Icon name="target" size={13} />} Build pack
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
          {running ? <span className="spinner" /> : <Icon name="chart" size={13} />} Run analysis
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
                  <Chip key={i} text={`${h.skill} ·${h.demand}`} tone={h.have ? 'green' : 'amber'} />
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
