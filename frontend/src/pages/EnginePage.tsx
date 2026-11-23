import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, type QaPair } from '../api/client';
import type { AgentStatus, EnginePrefill, EngineStatus } from '../types';
import { useToast } from '../lib/ui';
import { Icon } from '../components/Icon';
import { JobProfileEditor } from '../components/JobProfileEditor';
import { TagInput } from '../components/TagInput';
import { ROLE_SUGGESTIONS } from '../lib/roles';
import { LOCATION_SUGGESTIONS } from '../lib/locations';
import { RunControls, PortalPanel, ScheduleEditor } from '../components/AutomationPanels';
import { Panel, SettingRow } from '../components/Page';
import { startPoll } from '../lib/poll';

/**
 * Auto Apply — the automation's home. Setup (what you're looking for + your profile), the live
 * Activity feed and the daily Schedule; LinkedIn and Indeed each have their own page (the worker
 * searches + Easy-Applies there). The old cross-source "engine/Sourcing" layer was removed.
 */

/** Tabs on a PORTAL page (LinkedIn / Indeed). Automation itself is setup-only now. */
type PortalTab = 'activity' | 'questions' | 'schedule';

/** Up to two initials for the profile-card avatar. */
function initialsOf(name?: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function EnginePage() {
  const toast = useToast();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [portalTab, setPortalTab] = useState<PortalTab>('activity');

  const loadStatus = useCallback(() => {
    // Deliberately silent on failure. This polls every 5s, so toasting each error buried the
    // screen in "Failed to fetch" while the backend was simply unreachable. The page already
    // shows what it knows; a transient poll failure is not something to interrupt anyone for.
    api.engineStatus().then(setStatus).catch(() => {});
  }, [toast]);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 5000); // live while scrape/rank runs
    return () => clearInterval(t);
  }, [loadStatus]);

  const location = useLocation();
  const section = (location.pathname.split('/')[2] || '') as '' | 'linkedin' | 'indeed';
  const head = HEAD[section] ?? HEAD[''];

  // Automation is SETUP ONLY now. Activity, screening questions and the schedule are per-portal
  // concerns, so they live on the LinkedIn and Indeed pages where the numbers they describe are.
  // Keeping a second copy here meant two places showed "activity" and neither was obviously the
  // one to trust.
  // No separate Overview: it showed the metrics AND the activity feed, so an Activity tab beside
  // it was the same screen twice. Activity is the one view — stats on top, feed below.
  const portalTabs: [PortalTab, string, string][] = [
    ['activity', 'live', 'Activity'],
    ['questions', 'clipboard', 'Screening questions'],
    ['schedule', 'clock', 'Schedule'],
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            {head.title}{' '}
            {section === '' && status?.setupReady && <span className="chip chip-ok page-badge"><Icon name="check" size={12} /> Setup ready</span>}
          </h1>
          <div className="page-sub">{head.sub}</div>
        </div>
        {section !== '' && (
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <RunControls portal={section} />
          </div>
        )}
      </div>

      {section === '' ? <SetupTab status={status} onChange={loadStatus} /> : (
        <>
          <div className="tabs">
            {portalTabs.map(([t, ico, label]) => (
              <div key={t} className={`tab meta-item ${portalTab === t ? 'active' : ''}`} onClick={() => setPortalTab(t)}>
                <Icon name={ico} size={14} /> {label}
              </div>
            ))}
          </div>
          {portalTab === 'activity' && <PortalPanel portal={section} />}
          {portalTab === 'questions' && <ScreeningQuestions portal={section} />}
          {portalTab === 'schedule' && <ScheduleEditor portal={section} />}
        </>
      )}
    </>
  );
}

const HEAD: Record<string, { title: string; sub: string }> = {
  '': { title: 'Auto apply', sub: 'Tell it what you’re looking for and how to answer application forms. LinkedIn and Indeed each have their own page for activity and schedule.' },
  linkedin: { title: 'LinkedIn', sub: 'What the automation does on LinkedIn — searched, relevant, applied, connections, emails and manual-needed. Tap a tile to see the jobs.' },
  indeed: { title: 'Indeed', sub: 'What the automation does on Indeed — searched, relevant, applied and manual-needed. Tap a tile to see the jobs.' },
};

// ---- LinkedIn questions -----------------------------------------------------
// Screening questions the automation met that NEITHER your profile nor job profile could
// answer on their own — so it either left them blank or had the AI guess. Keep an answer here
// once and every later application with the same question uses it. (source pending|auto; the
// answers you Save from the extension live in Profile → Autofill answers, not here.)

function ScreeningQuestions({ portal }: { portal: 'linkedin' | 'indeed' }) {
  const toast = useToast();
  const [items, setItems] = useState<QaPair[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // EVERY question, on both pages — deliberately.
  //
  // The answer bank is keyed on (user, question), one row per question for the whole account,
  // so an answer given here is reused on Indeed too. Splitting the list per portal would imply
  // two independent sets and hide half your answers behind the wrong tab. The `portal` field
  // only records where a question was FIRST met, and is shown as a badge.
  const load = () => api.qaList()
    .then((list) => setItems(list
      .filter((q) => q.source === 'pending' || q.source === 'auto')
      // Unanswered first — those are the ones actually waiting on you. Then this portal's own
      // questions, so the page you're on leads with what it met.
      .sort((a, b) =>
        Number(!!(a.answer && a.answer.trim())) - Number(!!(b.answer && b.answer.trim()))
        || Number(b.portal === portal) - Number(a.portal === portal))))
    .catch(() => setItems([]));
  useEffect(() => { load(); }, [portal]);

  const startEdit = (it: QaPair) => { setEditing(it.id); setDraft(it.answer || ''); };
  const saveEdit = async (it: QaPair) => {
    if (!draft.trim()) { toast('Type an answer first', 'error'); return; }
    setBusy(it.id);
    try {
      const updated = await api.qaUpdate(it.id, { question: it.question, answer: draft.trim() });
      setItems((x) => (x ?? []).map((i) => (i.id === it.id ? updated : i)));
      setEditing(null);
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  const remove = async (it: QaPair) => {
    if (!window.confirm('Delete this question?')) return;
    setBusy(it.id);
    try { await api.qaDelete(it.id); setItems((x) => (x ?? []).filter((i) => i.id !== it.id)); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(null); }
  };

  if (items === null) return <div className="empty"><span className="spinner" /></div>;

  return (
    <div className="card card-pad">
      <div className="section-title" style={{ marginBottom: 4 }}>Screening questions</div>
      <div className="faint" style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
        Questions the automation met that your profile couldn’t answer. <b>One answer works
        everywhere</b> — the bank holds a single row per question, so answering here also answers
        it on the other portal. That is why this list is the same on both pages; the badge shows
        where each was first asked.
      </div>
      {items.length === 0 ? (
        <div className="faint" style={{ fontSize: 13 }}>
          Nothing yet. When the automation meets a question it can’t answer from your profile,
          it lands here for you to answer.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {items.map((it) => {
            const answered = !!(it.answer && it.answer.trim());
            return (
              <div key={it.id} className="lq-row">
                <div className="lq-body">
                  <div className="lq-label">
                    Question
                    {it.portal
                      ? <span className={`tone tone-${it.portal === 'linkedin' ? 'blue' : 'indigo'}`}
                          style={{ marginLeft: 8, fontSize: 10.5 }}>first asked on {it.portal}</span>
                      : <span className="tone tone-slate" style={{ marginLeft: 8, fontSize: 10.5 }}>
                          portal not recorded</span>}
                  </div>
                  <div className="lq-question">{it.question}</div>
                  <div className="lq-label" style={{ marginTop: 10 }}>
                    Answer {!answered && <span className="tone tone-amber">needs your answer</span>}
                  </div>
                  {editing === it.id ? (
                    <textarea className="input" rows={2} autoFocus value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="Type the answer to use for this question…"
                      style={{ marginTop: 4, width: '100%' }} />
                  ) : (
                    <div className={`lq-answer ${answered ? '' : 'faint'}`}>
                      {answered ? it.answer : 'No answer yet'}
                    </div>
                  )}
                </div>
                <div className="lq-actions">
                  {editing === it.id ? (
                    <>
                      <button className="btn btn-primary btn-sm" disabled={busy === it.id} onClick={() => saveEdit(it)}>Save</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={() => startEdit(it)} title="Edit answer">
                        <Icon name="pen" size={13} /> Edit
                      </button>
                      <button className="btn btn-ghost btn-sm" disabled={busy === it.id} onClick={() => remove(it)}
                        style={{ color: 'var(--danger)' }} title="Delete">
                        <Icon name="trash" size={13} /> Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


// ---- Setup ------------------------------------------------------------------
//
// Top to bottom: what the automation is doing right now (the hero), how far setup has got
// (three steps), then each step as its own section. Nothing here is a wall of fields — each
// setting is a row that says what it's for.

function SetupTab({ status, onChange }: { status: EngineStatus | null; onChange: () => void }) {
  const toast = useToast();
  const [me, setMe] = useState<EnginePrefill | null>(null);
  const [roles, setRoles] = useState('');
  const [locations, setLocations] = useState('');
  const [careerGoal, setCareerGoal] = useState('');
  const [dealBreakers, setDealBreakers] = useState('');
  const [wins, setWins] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.engineProfile().then((p) => {
      // Restore the saved search config so the fields survive a refresh.
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
      setRoles((r) => r || [p.currentTitle, p.headline].filter(Boolean).join(', '));
      setLocations((l) => l || [p.location, ...(p.preferredLocations || [])].filter(Boolean).join(', '));
    }).catch(() => {});
  }, []);

  const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  const saveGuided = async () => {
    if (csv(roles).length === 0) { toast('Add at least one target role', 'error'); return; }
    setSaving(true);
    try {
      await api.engineGuided({ roles: csv(roles), locations: csv(locations), careerGoal, dealBreakers: csv(dealBreakers), wins });
      toast('Search saved', 'success');
      onChange();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setSaving(false); }
  };

  const detailsDone = !!me && !!me.fullName && me.hasResume;
  const searchDone = !!status?.setupReady;
  const steps: { id: string; t: string; d: string; done: boolean }[] = [
    { id: 'setup-details', t: 'Your details', d: detailsDone ? 'Name and résumé on file' : me ? (me.hasResume ? 'Add your name in Profile' : 'Upload a résumé in Profile') : 'Checking…', done: detailsDone },
    { id: 'setup-search', t: 'What you’re looking for', d: searchDone ? `${csv(roles).length} role${csv(roles).length === 1 ? '' : 's'} · ${csv(locations).length || 'any'} location${csv(locations).length === 1 ? '' : 's'}` : 'Pick roles and locations', done: searchDone },
    { id: 'setup-answers', t: 'Application answers', d: 'Pay, eligibility and screening answers', done: false },
  ];

  return (
    <div className="stack">
      <AutomationHero />

      <ol className="steps" aria-label="Setup">
        {steps.map((st, n) => (
          <li key={st.id}>
            <a className={`step ${st.done ? 'done' : ''}`} href={`#${st.id}`}>
              <span className="step-n">{st.done ? <Icon name="check" size={13} /> : n + 1}</span>
              <span className="step-body"><span className="step-t">{st.t}</span><span className="step-d">{st.d}</span></span>
            </a>
          </li>
        ))}
      </ol>

      <Panel id="setup-details" icon="user" title="Your details"
        sub="From your Profile. Used for matching and to fill in applications."
        actions={<a className="btn btn-sm" href="/profile"><Icon name="pen" size={13} /> Edit in Profile</a>}>
        {me ? (
          <div className="who">
            <div className="who-top">
              <span className="who-av">{initialsOf(me.fullName)}</span>
              <div className="who-id">
                <div className="who-name">{me.fullName || <span className="faint">Add your name in Profile</span>}</div>
                <div className="who-role">{me.currentTitle || 'Role not set'}{me.currentCompany ? ` · ${me.currentCompany}` : ''}</div>
              </div>
              <span className={`chip ${me.hasResume ? 'chip-ok' : 'chip-warn'}`}>
                <Icon name={me.hasResume ? 'check' : 'alert'} size={12} /> {me.hasResume ? 'Résumé on file' : 'No résumé'}
              </span>
            </div>
            <div className="who-facts">
              {me.yearsExperience && <span><Icon name="clock" size={14} /> {me.yearsExperience} yr{me.yearsExperience === '1' ? '' : 's'} experience</span>}
              {me.email && <span><Icon name="mail" size={14} /> {me.email}</span>}
              {me.phone && <span><Icon name="phone" size={14} /> {me.phone}</span>}
              {me.location && <span><Icon name="target" size={14} /> {me.location}</span>}
            </div>
            {me.skills?.length > 0 && (
              <div className="who-skills">
                <span className="who-lab">Skills</span>
                {me.skills.slice(0, 16).map((sk) => <span key={sk} className="chip chip-neutral">{sk}</span>)}
                {me.skills.length > 16 && <span className="chip chip-neutral">+{me.skills.length - 16}</span>}
              </div>
            )}
          </div>
        ) : <div className="sc-loading"><span className="spinner" /> Loading your profile…</div>}
      </Panel>

      <Panel id="setup-search" icon="search" title="What you're looking for" flush
        sub="The roles and places the automation searches on LinkedIn and Indeed."
        footer={<>
          <span className="sc-f-note">{searchDone ? 'Saved. The next run searches these.' : 'Not saved yet'}</span>
          <button className="btn btn-primary" onClick={saveGuided} disabled={saving}>
            {saving ? <span className="spinner" /> : <Icon name="check" size={14} />} Save search
          </button>
        </>}>
        <SettingRow label="Target roles" hint="Job titles to search. Start typing to pick a suggestion, or enter your own.">
          <TagInput value={csv(roles)} suggestions={ROLE_SUGGESTIONS} placeholder="e.g. Full Stack Developer"
            onChange={(v) => setRoles(v.join(', '))} />
        </SettingRow>
        <SettingRow label="Locations" hint="Cities, states, or Remote. Leave empty to search everywhere.">
          <TagInput value={csv(locations)} suggestions={LOCATION_SUGGESTIONS} placeholder="e.g. Bengaluru"
            onChange={(v) => setLocations(v.join(', '))} />
        </SettingRow>
      </Panel>

      {/* Pay, eligibility and screening answers — used to fill in applications */}
      <div id="setup-answers"><JobProfileEditor /></div>
    </div>
  );
}

/**
 * What the automation is doing right now, in one sentence, with the one action that changes it.
 * Built only from what the server reports (agent status) — nothing inferred.
 */
function AutomationHero() {
  const [st, setSt] = useState<AgentStatus | null>(null);
  useEffect(() => {
    const load = () => api.agentStatus().then(setSt).catch(() => {});
    return startPoll(load, 8000);
  }, []);
  const run = st?.activeRun ?? null;
  const running = !!run && ['running', 'queued', 'needs_attention'].includes(run.status);
  const state: { tone: string; ico: string; t: string; d: string } = !st
    ? { tone: 'idle', ico: 'clock', t: 'Checking the automation…', d: '' }
    : !st.workerConfigured ? { tone: 'danger', ico: 'live', t: 'Desktop app not connected', d: 'Auto apply runs in the JobPilot desktop app on your computer. Install it and sign in to start.' }
    : running && run?.status === 'needs_attention' ? { tone: 'warn', ico: 'alert', t: `${run.portal} run needs you`, d: 'It stopped at a step it can’t finish on its own. Open the desktop app to continue.' }
    : running ? { tone: 'ok', ico: 'play', t: `Running on ${run?.portal}`, d: st.liveAction || 'Searching, scoring and applying.' }
    : st.paused ? { tone: 'warn', ico: 'pause', t: 'Auto apply is paused', d: 'Nothing is sent until you resume it in the desktop app.' }
    : !st.workerOnline ? { tone: 'idle', ico: 'live', t: 'Desktop app is offline', d: 'Open the desktop app so scheduled runs can start.' }
    : { tone: 'ok', ico: 'check', t: 'Ready', d: 'The next scheduled run starts on its own.' };
  return (
    <section className="card hero" aria-live="polite">
      <div className="hero-state">
        <span className={`hero-ic hero-${state.tone}`}><Icon name={state.ico} size={18} /></span>
        <div className="hero-txt"><h3>{state.t}</h3>{state.d && <p>{state.d}</p>}</div>
      </div>
      {st && (
        <dl className="hero-meta">
          <div><dt>Applied today</dt><dd>{st.metricsToday?.applied ?? '—'}</dd></div>
          <div><dt>Waiting for OK</dt><dd>{st.pendingApprovals}</dd></div>
          <div><dt>Desktop</dt><dd>{st.workerOnline ? 'Online' : 'Offline'}</dd></div>
        </dl>
      )}
      <div className="hero-act"><RunControls /></div>
    </section>
  );
}
