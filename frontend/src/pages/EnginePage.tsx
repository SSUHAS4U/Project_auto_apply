import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type {
  EngineApplication, EngineApplicationSummary, EngineDoc, EngineInterview, EngineJob,
  EnginePrefill, EngineProfile, EngineStatus, EngineUpskill,
} from '../types';
import { fmtDate, useToast } from '../lib/ui';
import { Icon } from '../components/Icon';
import { JobProfileEditor } from '../components/JobProfileEditor';
import { JobCard } from '../components/JobCard';
import { Select } from '../components/Select';
import type { CSSProperties } from 'react';
import { useLocation } from 'react-router-dom';
import { RunControls, PortalPanel, ActivityFeed, ScheduleEditor } from '../components/AutomationPanels';

/**
 * Auto Apply — a clean-room replica of the ai-job-search framework, built as its own
 * component (backend package com.jobpilot.engine, tables engine_*, API /api/engine/**).
 * It shares only generic plumbing (AI, LaTeX compile, PDF, mail) with the rest of the app.
 * Flow: Setup → Scrape → Rank → Apply (draft → review → revise → compile → ATS verify)
 *       → Outcome → Interview → Upskill.
 */

type Tab = 'setup' | 'activity' | 'schedule';

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

/** Up to two initials for the profile-card avatar. */
function initialsOf(name?: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function EnginePage() {
  const toast = useToast();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [tab, setTab] = useState<Tab>('setup');
  const [ptab, setPtab] = useState<'overview' | 'interview' | 'upskill'>('overview');

  const loadStatus = useCallback(() => {
    api.engineStatus().then(setStatus).catch((e) => toast(e.message, 'error'));
  }, [toast]);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 5000); // live while scrape/rank runs
    return () => clearInterval(t);
  }, [loadStatus]);

  const busy = status?.scrapeRunning || status?.rankRunning;
  const location = useLocation();
  const section = (location.pathname.split('/')[2] || '') as '' | 'linkedin' | 'indeed' | 'sourcing';
  const head = HEAD[section] ?? HEAD[''];
  const isPortal = section === 'linkedin' || section === 'indeed' || section === 'sourcing';
  // Automation holds Setup + Activity + Schedule. Interview/Upskill are their own sidebar pages.
  const autoTabs: [Tab, string, string][] = [
    ['setup', 'gear', 'Setup'], ['activity', 'live', 'Activity'], ['schedule', 'clock', 'Schedule'],
  ];
  const activeTab: Tab = autoTabs.some(([t]) => t === tab) ? tab : 'setup';

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            {head.title}{' '}
            {status && !status.aiEnabled && <Chip text="AI off" tone="red" />}
            {section === '' && status?.setupReady && <> <Chip text="setup ready" tone="green" /></>}
          </h1>
          <div className="page-sub">{head.sub}</div>
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

      {/* Each portal (LinkedIn / Indeed / Sourcing) is its own page with Overview + its own
          Interview & Upskill — so you can see interviews/upskilling per source. */}
      {isPortal ? (
        <>
          {section === 'sourcing' && status && <AutopilotBanner status={status} onChange={loadStatus} />}
          <div className="tabs">
            {([
              ['overview', section, section === 'sourcing' ? 'Ranked jobs' : 'Jobs'],
              ['interview', 'target', 'Interview'],
              ['upskill', 'chart', 'Upskill'],
            ] as [typeof ptab, string, string][]).map(([t, ico, label]) => (
              <div key={t} className={`tab meta-item ${ptab === t ? 'active' : ''}`} onClick={() => setPtab(t)}>
                <Icon name={ico} size={14} /> {label}
              </div>
            ))}
          </div>
          {ptab === 'overview' && (section === 'sourcing'
            ? <EngineTab status={status} onChange={loadStatus} />
            : <PortalPanel portal={section as 'linkedin' | 'indeed'} />)}
          {ptab === 'interview' && <InterviewTab source={section} />}
          {ptab === 'upskill' && <UpskillTab source={section} />}
        </>
      ) : (
        <>
          {status && <AutopilotBanner status={status} onChange={loadStatus} />}
          <div className="tabs">
            {autoTabs.map(([t, ico, label]) => (
              <div key={t} className={`tab meta-item ${activeTab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                <Icon name={ico} size={14} /> {label}
              </div>
            ))}
          </div>
          {activeTab === 'setup' && <SetupTab status={status} onChange={loadStatus} />}
          {activeTab === 'activity' && <ActivityFeed />}
          {activeTab === 'schedule' && <ScheduleEditor />}
        </>
      )}
    </>
  );
}

const HEAD: Record<string, { title: string; sub: string }> = {
  '': { title: 'Automation', sub: 'Set up what you’re looking for, watch the live activity, and set the daily schedule. Each portal has its own page in the sidebar.' },
  linkedin: { title: 'LinkedIn', sub: 'What the automation does on LinkedIn — searched, relevant, applied, connections, emails and manual-needed. Tap a tile to see the jobs.' },
  indeed: { title: 'Indeed', sub: 'What the automation does on Indeed — searched, relevant, applied and manual-needed. Tap a tile to see the jobs.' },
  sourcing: { title: 'Sourcing', sub: 'Cross-source jobs from company boards (Greenhouse, Lever, Ashby…) + APIs — scraped, AI-ranked, then applied by email or built into ready-to-send packages.' },
  interview: { title: 'Interview prep', sub: 'AI interview packs generated from your applications — likely questions, talking points and STAR stories.' },
  upskill: { title: 'Upskill', sub: 'Skill gaps the engine spotted across the roles you want, with focused things to learn next.' },
};


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
          <div className="pcard">
            <div className="pcard-banner" />
            <div className="pcard-body">
              <div className="pcard-top">
                <div className="pcard-avatar">{initialsOf(me.fullName)}</div>
                <div className="pcard-id">
                  <div className="pcard-name">{me.fullName || <em className="faint">Add your name in Profile</em>}</div>
                  <div className="pcard-role">
                    {me.currentTitle || 'Role not set'}{me.currentCompany ? ` · ${me.currentCompany}` : ''}
                  </div>
                </div>
                <span className={`pcard-status ${me.hasResume ? 'ok' : 'warn'}`}>
                  <Icon name={me.hasResume ? 'check' : 'alert'} size={13} /> {me.hasResume ? 'Résumé uploaded' : 'No résumé'}
                </span>
              </div>

              <div className="pcard-pills">
                {me.yearsExperience && <span className="pcard-pill"><Icon name="bolt" size={13} /> {me.yearsExperience} yr{me.yearsExperience === '1' ? '' : 's'} experience</span>}
                {me.email && <span className="pcard-pill"><Icon name="mail" size={13} /> {me.email}</span>}
                {me.phone && <span className="pcard-pill"><Icon name="phone" size={13} /> {me.phone}</span>}
                {me.location && <span className="pcard-pill"><Icon name="target" size={13} /> {me.location}</span>}
              </div>

              {me.skills?.length > 0 && (
                <div className="pcard-skills">
                  <div className="pcard-label">Top skills <span className="faint">· {me.skills.length}</span></div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {me.skills.slice(0, 18).map((s) => <span key={s} className="chip">{s}</span>)}
                    {me.skills.length > 18 && <span className="chip" style={{ opacity: .65 }}>+{me.skills.length - 18} more</span>}
                  </div>
                </div>
              )}

              <a className="pcard-edit" href="/profile"><Icon name="user" size={13} /> Edit in Profile</a>
            </div>
          </div>
        ) : <span className="spinner" />}
      </div>

      {/* Step 2 — what you're looking for (no AI needed) */}
      <div className="card card-pad">
        <div className="step-head">
          <span className="step-num">2</span>
          <div><div className="step-title">What you're looking for</div><div className="step-sub">All the engine needs to find &amp; rank jobs — no AI required. Separate entries with commas.</div></div>
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          <label style={{ fontSize: 13 }}>Target roles <span className="faint">— job titles to search</span>
            <input className="input" style={{ width: '100%' }} value={roles} onChange={(e) => setRoles(e.target.value)}
              placeholder="e.g. Full-Stack Developer, Java Backend Engineer, React Developer" />
          </label>
          <label style={{ fontSize: 13 }}>Locations <span className="faint">— cities + Remote</span>
            <input className="input" style={{ width: '100%' }} value={locations} onChange={(e) => setLocations(e.target.value)}
              placeholder="e.g. Bengaluru, Hyderabad, Remote" />
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

// ---- Engine (cross-source: ATS boards + APIs) -------------------------------

/** The Sourcing view: clean metric cards on top (tap to filter), then ranked matches + packages. */
function EngineTab({ status, onChange }: { status: EngineStatus | null; onChange: () => void }) {
  const [filter, setFilter] = useState('ranked');
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <EngineMetrics status={status} filter={filter} onFilter={setFilter} />
      <JobsTab status={status} onChange={onChange} onApplied={onChange} filter={filter} setFilter={setFilter} />
      <ApplicationsTab />
    </div>
  );
}

function EngineMetrics({ status, filter, onFilter }:
  { status: EngineStatus | null; filter: string; onFilter: (f: string) => void }) {
  const jc = status?.jobStatusCounts ?? {};
  const ac = status?.appStageCounts ?? {};
  const searched = ['new', 'shortlisted', 'ranked', 'applied', 'expired', 'vetoed'].reduce((a, k) => a + (jc[k] ?? 0), 0);
  // `f` = which ranked-list filter this tile jumps to (null = informational app-stage tile).
  const cells: { label: string; v: number; color: string; f: string | null }[] = [
    { label: 'Searched', v: searched, color: 'var(--accent-hi)', f: 'all' },
    { label: 'Relevant', v: (jc.ranked ?? 0) + (jc.shortlisted ?? 0), color: 'var(--amber)', f: 'ranked' },
    { label: 'Applied', v: jc.applied ?? 0, color: 'var(--green)', f: 'applied' },
    { label: 'Packages ready', v: ac.ready ?? 0, color: 'var(--blue)', f: null },
    { label: 'Emailed / sent', v: (ac.submitted ?? 0) + (ac.sent ?? 0), color: 'var(--purple)', f: null },
    { label: 'Failed', v: ac.failed ?? 0, color: 'var(--red)', f: null },
  ];
  return (
    <div className="card card-pad">
      <div className="card-title"><Icon name="search" size={15} /> Sourcing
        <span className="faint" style={{ fontSize: 12, fontWeight: 400, marginLeft: 6 }}>· jobs from company boards + APIs · tap a tile to filter the list below</span>
      </div>
      <div className="mtile-grid">
        {cells.map((c) => {
          const active = c.f !== null && c.f === filter;
          const clickable = c.f !== null;
          return (
            <button key={c.label} className={`mtile ${clickable ? 'mtile-btn' : ''} ${active ? 'sel' : ''}`}
              disabled={!clickable}
              style={{ ['--mtile-c']: c.v ? c.color : 'var(--text-faint)', cursor: clickable ? 'pointer' : 'default' } as CSSProperties}
              onClick={() => clickable && onFilter(c.f!)}>
              <span className="mtile-num">{c.v}</span>
              <span className="mtile-label">{c.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function JobsTab({ status, onChange, onApplied, filter, setFilter }:
  { status: EngineStatus | null; onChange: () => void; onApplied: () => void; filter: string; setFilter: (f: string) => void }) {
  const toast = useToast();
  const [jobs, setJobs] = useState<EngineJob[]>([]);
  const [applyingId, setApplyingId] = useState('');

  // fresh=true re-sorts (initial load / filter change). fresh=false MERGES: existing cards keep
  // their position and just refresh in place, new ones append — so live polling during a
  // scrape/rank doesn't reshuffle the list under you.
  const load = useCallback((fresh = false) => {
    api.engineJobs(filter === 'all' ? undefined : filter).then((incoming) => {
      setJobs((prev) => {
        if (fresh || prev.length === 0) return incoming;
        const byId = new Map(incoming.map((j) => [j.id, j]));
        const kept = prev.filter((j) => byId.has(j.id)).map((j) => byId.get(j.id)!);
        const keptIds = new Set(kept.map((j) => j.id));
        return [...kept, ...incoming.filter((j) => !keptIds.has(j.id))];
      });
    }).catch(() => {});
  }, [filter]);
  useEffect(() => { load(true); }, [load]);
  useEffect(() => {
    if (status?.scrapeRunning || status?.rankRunning) { const t = setInterval(() => load(false), 4000); return () => clearInterval(t); }
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
      <div className="section-title" style={{ margin: '2px 0 0' }}><Icon name="compass" size={15} /> Ranked matches</div>
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
        <Select value={filter} onChange={setFilter} style={{ marginLeft: 'auto' }}
          options={[
            { value: 'ranked', label: 'Ranked (best first)' }, { value: 'shortlisted', label: 'Shortlisted' },
            { value: 'new', label: 'New (unranked)' }, { value: 'applied', label: 'Applied' },
            { value: 'expired', label: 'Expired' }, { value: 'all', label: 'All' },
          ]} />
      </div>

      {jobs.length === 0 ? (
        <div className="card card-pad empty">
          <div className="big"><Icon name="search" size={34} /></div>
          {status?.setupReady ? 'No jobs yet. Scrape LinkedIn, then Rank.' : 'Run Setup first, then Scrape LinkedIn.'}
        </div>
      ) : jobs.map((j) => (
        <JobCard key={j.id}
          title={j.title || 'Role'}
          company={j.company}
          location={j.location}
          source={j.source}
          url={j.url}
          score={j.fitScore}
          verdict={j.verdict}
          metaRight={j.postedAt || undefined}
          strengths={j.strengths}
          gaps={j.gaps}
          dealBreaker={j.dealBreaker}
          badges={j.urgent ? <Chip text="urgent" tone="amber" /> : undefined}
          actions={<>
            {j.status !== 'applied' && j.status !== 'applying' && (
              <button className="btn btn-primary btn-sm" onClick={() => apply(j)} disabled={applyingId === j.id || !status?.setupReady}>
                {applyingId === j.id ? <span className="spinner" /> : <Icon name="pen" size={13} />} Apply
              </button>
            )}
            {j.status === 'applied' && <Chip text="applied" tone="green" />}
            {j.status === 'applying' && <span className="row" style={{ gap: 6, alignItems: 'center' }}><span className="spinner" /> <Chip text="applying…" tone="indigo" /></span>}
            <button className="btn btn-ghost btn-sm" onClick={() => dismiss(j)} title="Dismiss"><Icon name="x" size={14} /></button>
          </>}
        />
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
      <div className="section-title" style={{ margin: '2px 0 0' }}><Icon name="clipboard" size={15} /> Application packages</div>
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

function InterviewTab({ source }: { source?: string } = {}) {
  const toast = useToast();
  void source; // per-source scoping is a backend follow-up; content is shared for now
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
          <select className="select" style={{ maxWidth: 300 }} value={appId} onChange={(e) => setAppId(e.target.value)}>
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

function UpskillTab({ source }: { source?: string } = {}) {
  const toast = useToast();
  void source; // per-source scoping is a backend follow-up; content is shared for now
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
