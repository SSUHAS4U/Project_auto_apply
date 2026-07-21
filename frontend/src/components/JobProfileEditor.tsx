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
