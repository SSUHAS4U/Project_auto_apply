import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AchievementItem, Profile, ProjectItem } from '../types';
import { useToast } from '../lib/ui';
import { Icon } from './Icon';

/**
 * The Job Profile — what you hunt for + showcase material (projects, achievements).
 * Lives on the Auto Apply → Setup page (owner's choice): it's automation configuration,
 * not identity. Self-contained load/save against /api/profile.
 */
export function JobProfileEditor() {
  const toast = useToast();
  const [p, setP] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.profile().then(setP).catch(() => {}); }, []);

  if (!p) return <div className="card card-pad"><span className="spinner" /></div>;
  const set = (patch: Partial<Profile>) => setP((x) => ({ ...(x as Profile), ...patch }));

  const save = async () => {
    setSaving(true);
    try { setP(await api.saveProfile(p)); toast('Job profile saved', 'success'); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setSaving(false); }
  };

  const updList = <T,>(list: T[] | undefined, i: number, patch: Partial<T>): T[] =>
    (list ?? []).map((it, idx) => (idx === i ? { ...it, ...patch } : it));
  const dropAt = <T,>(list: T[] | undefined, i: number): T[] => (list ?? []).filter((_, idx) => idx !== i);

  return (
    <div className="card card-pad">
      <div className="step-head">
        <span className="step-num"><Icon name="target" size={14} /></span>
        <div>
          <div className="step-title">Compensation &amp; showcase</div>
          <div className="step-sub">Pay expectations, projects &amp; achievements — used for screening answers and CV tailoring. Your roles &amp; locations are set in step 2 above.</div>
        </div>
      </div>

      <div className="grid2">
        <Field label="Experience level">
          <select className="select" value={p.experienceLevel ?? ''} onChange={(e) => set({ experienceLevel: e.target.value })}>
            <option value="">Select…</option>
            {['0-2 Years', '2-5 Years', '5-8 Years', '8+ Years'].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Job type">
          <select className="select" value={p.jobType ?? ''} onChange={(e) => set({ jobType: e.target.value })}>
            <option value="">Select…</option>
            {['Full-time', 'Part-time', 'Internship', 'Contract', 'Freelance'].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Compensation expected (annual)">
          <input className="input" placeholder="800000" value={p.expectedCtc ?? ''} onChange={(e) => set({ expectedCtc: e.target.value })} />
        </Field>
        <Field label="Current compensation (annual)">
          <input className="input" placeholder="e.g. 800000" value={p.currentCtc ?? ''} onChange={(e) => set({ currentCtc: e.target.value })} />
        </Field>
      </div>

      {/* Contact & location — used to fill the identity part of Easy Apply forms */}
      <div className="jp-subhead"><Icon name="target" size={14} /> Contact &amp; location</div>
      <div className="grid2">
        <Field label="Phone country code"><input className="input" placeholder="+91" value={p.phoneCountryCode ?? ''} onChange={(e) => set({ phoneCountryCode: e.target.value })} /></Field>
        <Field label="Phone number"><input className="input" placeholder="9494571573" value={p.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} /></Field>
        <Field label="Address" full><input className="input" placeholder="Bengaluru, Karnataka" value={p.address ?? ''} onChange={(e) => set({ address: e.target.value })} /></Field>
        <Field label="City"><input className="input" value={p.city ?? ''} onChange={(e) => set({ city: e.target.value })} /></Field>
        <Field label="State"><input className="input" value={p.state ?? ''} onChange={(e) => set({ state: e.target.value })} /></Field>
        <Field label="ZIP / postal code"><input className="input" placeholder="560001" value={p.postalCode ?? ''} onChange={(e) => set({ postalCode: e.target.value })} /></Field>
        <Field label="Country"><input className="input" placeholder="India" value={p.country ?? ''} onChange={(e) => set({ country: e.target.value })} /></Field>
      </div>

      {/* Work preferences — the screening questions Easy Apply asks most */}
      <div className="jp-subhead"><Icon name="bolt" size={14} /> Work preferences</div>
      <div className="grid2">
        <Field label="Years of experience"><input className="input" placeholder="1" value={p.yearsExperience ?? ''} onChange={(e) => set({ yearsExperience: e.target.value })} /></Field>
        <Field label="Notice period (days)"><input className="input" placeholder="15" value={p.noticePeriod ?? ''} onChange={(e) => set({ noticePeriod: e.target.value })} /></Field>
        <Field label="Available start date"><input className="input" placeholder="Immediately" value={p.availableFrom ?? ''} onChange={(e) => set({ availableFrom: e.target.value })} /></Field>
        <YesNo label="Authorized to work (in target country)" value={boolOf(p.workAuthorization)} onChange={(v) => set({ workAuthorization: v === null ? '' : v ? 'Yes' : 'No' })} />
        <YesNo label="Requires visa sponsorship" value={p.requiresSponsorship ?? null} onChange={(v) => set({ requiresSponsorship: v })} />
        <YesNo label="Security clearance" value={p.securityClearance ?? null} onChange={(v) => set({ securityClearance: v })} />
        <YesNo label="Willing to relocate" value={p.willingToRelocate ?? null} onChange={(v) => set({ willingToRelocate: v })} />
        <YesNo label="Willing to work remote" value={p.willingRemote ?? null} onChange={(v) => set({ willingRemote: v })} />
        <YesNo label="Willing to work onsite" value={p.willingOnsite ?? null} onChange={(v) => set({ willingOnsite: v })} />
      </div>

      {/* Education */}
      <div className="jp-subhead"><Icon name="trophy" size={14} /> Education</div>
      <div className="grid2">
        <Field label="Highest education"><input className="input" placeholder="B.Tech" value={p.highestEducation ?? ''} onChange={(e) => set({ highestEducation: e.target.value })} /></Field>
        <Field label="School / university"><input className="input" placeholder="KL University" value={p.college ?? ''} onChange={(e) => set({ college: e.target.value })} /></Field>
        <Field label="GPA"><input className="input" placeholder="9.2" value={p.gpa ?? ''} onChange={(e) => set({ gpa: e.target.value })} /></Field>
        <YesNo label="Completed bachelor's" value={p.completedBachelors ?? null} onChange={(v) => set({ completedBachelors: v })} />
        <YesNo label="Tier-one institution" value={p.tierOneInstitution ?? null} onChange={(v) => set({ tierOneInstitution: v })} />
        <Field label="How did you hear about roles"><input className="input" placeholder="LinkedIn" value={p.howDidYouHear ?? ''} onChange={(e) => set({ howDidYouHear: e.target.value })} /></Field>
      </div>

      {/* Diversity — optional EEO questions; leave blank to skip / decline */}
      <div className="jp-subhead"><Icon name="target" size={14} /> Diversity <span className="faint">— optional, leave blank to decline</span></div>
      <div className="grid2">
        <Field label="Gender"><input className="input" placeholder="Male / Female / Decline" value={p.gender ?? ''} onChange={(e) => set({ gender: e.target.value })} /></Field>
        <Field label="Ethnicity"><input className="input" placeholder="Decline to self-identify" value={p.ethnicity ?? ''} onChange={(e) => set({ ethnicity: e.target.value })} /></Field>
        <Field label="Veteran status"><input className="input" placeholder="I am not a protected veteran" value={p.veteranStatus ?? ''} onChange={(e) => set({ veteranStatus: e.target.value })} /></Field>
        <Field label="Disability status"><input className="input" placeholder="I do not wish to answer" value={p.disabilityStatus ?? ''} onChange={(e) => set({ disabilityStatus: e.target.value })} /></Field>
        <YesNo label="Hispanic / Latino" value={p.hispanicLatino ?? null} onChange={(v) => set({ hispanicLatino: v })} />
      </div>

      {/* Projects */}
      <div className="jp-subhead"><Icon name="bolt" size={14} /> Projects <span className="faint">— showcase used in tailored CVs &amp; answers</span></div>
      {(p.projects ?? []).map((item: ProjectItem, i) => (
        <div className="repeat-row" key={i}>
          <div className="rh"><span className="muted" style={{ fontSize: 12, fontWeight: 700 }}>#{i + 1}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => set({ projects: dropAt(p.projects, i) })}><Icon name="trash" size={13} /> Remove</button></div>
          <div className="grid2">
            <Field label="Project name"><input className="input" value={item.name ?? ''} onChange={(e) => set({ projects: updList(p.projects, i, { name: e.target.value }) })} /></Field>
            <Field label="Demo / repo link"><input className="input" type="url" placeholder="https://…" value={item.demoLink ?? ''} onChange={(e) => set({ projects: updList(p.projects, i, { demoLink: e.target.value }) })} /></Field>
          </div>
          <Field label="Skill set used — comma-separated" full>
            <input className="input" placeholder="Spring Boot, React, PostgreSQL…" value={item.skills ?? ''} onChange={(e) => set({ projects: updList(p.projects, i, { skills: e.target.value }) })} />
          </Field>
          <Field label="Description — what it does & what you achieved" full>
            <textarea className="input" rows={3} value={item.description ?? ''} onChange={(e) => set({ projects: updList(p.projects, i, { description: e.target.value }) })} />
          </Field>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => set({ projects: [...(p.projects ?? []), {}] })}><Icon name="plus" size={13} /> Add project</button>

      {/* Achievements */}
      <div className="jp-subhead"><Icon name="trophy" size={14} /> Achievements</div>
      {(p.achievements ?? []).map((item: AchievementItem, i) => (
        <div className="repeat-row" key={i}>
          <div className="rh"><span className="muted" style={{ fontSize: 12, fontWeight: 700 }}>#{i + 1}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => set({ achievements: dropAt(p.achievements, i) })}><Icon name="trash" size={13} /> Remove</button></div>
          <Field label="Title" full><input className="input" placeholder="Winner — Smart India Hackathon 2025" value={item.title ?? ''} onChange={(e) => set({ achievements: updList(p.achievements, i, { title: e.target.value }) })} /></Field>
          <Field label="Details (optional)" full><textarea className="input" rows={2} value={item.description ?? ''} onChange={(e) => set({ achievements: updList(p.achievements, i, { description: e.target.value }) })} /></Field>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => set({ achievements: [...(p.achievements ?? []), {}] })}><Icon name="plus" size={13} /> Add achievement</button>

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? <span className="spinner" /> : <Icon name="check" size={14} />} Save job profile
        </button>
      </div>
    </div>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return <label className={`field ${full ? 'full' : ''}`}>{label}{children}</label>;
}

/** Yes/No/blank select for the boolean screening answers. */
function YesNo({ label, value, onChange }: { label: string; value: boolean | null; onChange: (v: boolean | null) => void }) {
  return (
    <label className="field">{label}
      <select className="select" value={value == null ? '' : value ? 'yes' : 'no'}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'yes')}>
        <option value="">Select…</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  );
}

/** work_authorization is stored as a "Yes"/"No" string; map it to a tri-state boolean. */
function boolOf(s?: string): boolean | null {
  if (!s) return null;
  return /^y/i.test(s) ? true : /^n/i.test(s) ? false : null;
}
