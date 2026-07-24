import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client';
import type { EnginePrefill, EngineStatus } from '../types';
import { useToast } from '../lib/ui';
import { Icon } from '../components/Icon';
import { JobProfileEditor } from '../components/JobProfileEditor';
import { TagInput } from '../components/TagInput';
import { ROLE_SUGGESTIONS } from '../lib/roles';
import { LOCATION_SUGGESTIONS } from '../lib/locations';
import { RunControls, PortalPanel, ActivityFeed, ScheduleEditor } from '../components/AutomationPanels';

/**
 * Auto Apply — the automation's home. Setup (what you're looking for + your profile), the live
 * Activity feed and the daily Schedule; LinkedIn and Indeed each have their own page (the worker
 * searches + Easy-Applies there). The old cross-source "engine/Sourcing" layer was removed.
 */

type Tab = 'setup' | 'activity' | 'schedule';

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

  const loadStatus = useCallback(() => {
    api.engineStatus().then(setStatus).catch((e) => toast(e.message, 'error'));
  }, [toast]);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 5000); // live while scrape/rank runs
    return () => clearInterval(t);
  }, [loadStatus]);

  const location = useLocation();
  const section = (location.pathname.split('/')[2] || '') as '' | 'linkedin' | 'indeed';
  const head = HEAD[section] ?? HEAD[''];
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
            {section === '' && status?.setupReady && <Chip text="setup ready" tone="green" />}
          </h1>
          <div className="page-sub">{head.sub}</div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <RunControls />
        </div>
      </div>

      {section === 'linkedin' ? <PortalPanel portal="linkedin" />
        : section === 'indeed' ? <PortalPanel portal="indeed" />
        : (
          <>
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
  '': { title: 'Automation', sub: 'Set up what you’re looking for, watch the live activity, and set the daily schedule. LinkedIn and Indeed each have their own page in the sidebar.' },
  linkedin: { title: 'LinkedIn', sub: 'What the automation does on LinkedIn — searched, relevant, applied, connections, emails and manual-needed. Tap a tile to see the jobs.' },
  indeed: { title: 'Indeed', sub: 'What the automation does on Indeed — searched, relevant, applied and manual-needed. Tap a tile to see the jobs.' },
};


// ---- Setup ------------------------------------------------------------------

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
      toast('Saved ✓', 'success');
      onChange();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setSaving(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Step 1 — your details (from the app Profile) */}
      <div className="card card-pad">
        <div className="step-head">
          <span className="step-num">1</span>
          <div><div className="step-title">Your details</div><div className="step-sub">Pulled from your Profile — used for matching and to fill your applications.</div></div>
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
          <div><div className="step-title">What you're looking for</div><div className="step-sub">The roles and locations the automation searches on LinkedIn &amp; Indeed. Start typing and pick from the suggestions, or enter your own.</div></div>
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ fontSize: 13 }}>Target roles <span className="faint">— job titles to search</span>
            <TagInput value={csv(roles)} suggestions={ROLE_SUGGESTIONS}
              placeholder="e.g. Full Stack Developer"
              onChange={(v) => setRoles(v.join(', '))} />
          </div>
          <div style={{ fontSize: 13 }}>Locations <span className="faint">— cities, states or Remote</span>
            <TagInput value={csv(locations)} suggestions={LOCATION_SUGGESTIONS}
              placeholder="e.g. Bengaluru"
              onChange={(v) => setLocations(v.join(', '))} />
          </div>
        </div>
        <div className="row" style={{ marginTop: 14, gap: 8, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={saveGuided} disabled={saving}>
            {saving ? <span className="spinner" /> : <Icon name="check" size={14} />} Save
          </button>
          {status?.setupReady && <Chip text="ready" tone="green" />}
        </div>
      </div>

      {/* Job profile — compensation, screening answers, projects (used to fill applications) */}
      <JobProfileEditor />
    </div>
  );
}

