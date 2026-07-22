import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Profile } from '../types';
import { useToast } from '../lib/ui';
import { Icon } from './Icon';
import { Select } from './Select';

/**
 * The Job Profile — what you hunt for + showcase material (projects, achievements).
 * Lives on the Auto Apply → Setup page (owner's choice): it's automation configuration,
 * not identity. Self-contained load/save against /api/profile.
 */
type Row = { k: string; v: string };

export function JobProfileEditor() {
  const toast = useToast();
  const [p, setP] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  // Per-skill years + custom screening answers are edited as ordered rows (a Map can't be
  // reliably key-edited in place), then serialised back to the profile on save.
  const [skillRows, setSkillRows] = useState<Row[]>([]);
  const [qaRows, setQaRows] = useState<Row[]>([]);
  useEffect(() => {
    api.profile().then((pr) => {
      setP(pr);
      setSkillRows(Object.entries(pr.skillsExperience ?? {}).map(([k, v]) => ({ k, v })));
      setQaRows(Object.entries(pr.fieldMap ?? {}).map(([k, v]) => ({ k, v })));
    }).catch(() => {});
  }, []);

  if (!p) return <div className="card card-pad"><span className="spinner" /></div>;
  const set = (patch: Partial<Profile>) => setP((x) => ({ ...(x as Profile), ...patch }));
  const rowsToMap = (rows: Row[]) =>
    Object.fromEntries(rows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v.trim()]));

  const save = async () => {
    setSaving(true);
    const merged = { ...p, skillsExperience: rowsToMap(skillRows), fieldMap: rowsToMap(qaRows) };
    try {
      const saved = await api.saveProfile(merged);
      setP(saved);
      setSkillRows(Object.entries(saved.skillsExperience ?? {}).map(([k, v]) => ({ k, v })));
      setQaRows(Object.entries(saved.fieldMap ?? {}).map(([k, v]) => ({ k, v })));
      toast('Job profile saved', 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setSaving(false); }
  };

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
          <Select value={p.experienceLevel ?? ''} onChange={(v) => set({ experienceLevel: v })}
            options={[{ value: '', label: 'Select…' }, ...['0-2 Years', '2-5 Years', '5-8 Years', '8+ Years'].map((o) => ({ value: o, label: o }))]} />
        </Field>
        <Field label="Job type">
          <Select value={p.jobType ?? ''} onChange={(v) => set({ jobType: v })}
            options={[{ value: '', label: 'Select…' }, ...['Full-time', 'Part-time', 'Internship', 'Contract', 'Freelance'].map((o) => ({ value: o, label: o }))]} />
        </Field>
        <Field label="Compensation expected (annual)">
          <input className="input" placeholder="800000" value={p.expectedCtc ?? ''} onChange={(e) => set({ expectedCtc: e.target.value })} />
        </Field>
        <Field label="Current compensation (annual)">
          <input className="input" placeholder="e.g. 800000" value={p.currentCtc ?? ''} onChange={(e) => set({ currentCtc: e.target.value })} />
        </Field>
      </div>

      {/* Contact — only the parts Easy Apply asks separately from the resume */}
      <div className="jp-subhead"><Icon name="target" size={14} /> Contact</div>
      <div className="grid2">
        <Field label="Phone country code"><input className="input" placeholder="+91" value={p.phoneCountryCode ?? ''} onChange={(e) => set({ phoneCountryCode: e.target.value })} /></Field>
        <Field label="Phone number"><input className="input" placeholder="9494571573" value={p.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} /></Field>
      </div>

      {/* Work preferences */}
      <div className="jp-subhead"><Icon name="bolt" size={14} /> Work preferences</div>
      <div className="grid2">
        <Field label="Default years of experience"><input className="input" placeholder="1" value={p.yearsExperience ?? ''} onChange={(e) => set({ yearsExperience: e.target.value })} /></Field>
        <Field label="Available start date"><input className="input" placeholder="Immediately" value={p.availableFrom ?? ''} onChange={(e) => set({ availableFrom: e.target.value })} /></Field>
        <YesNo label="Work authorized" value={boolOf(p.workAuthorization)} onChange={(v) => set({ workAuthorization: v === null ? '' : v ? 'Yes' : 'No' })} />
        <YesNo label="Requires sponsorship" value={p.requiresSponsorship ?? null} onChange={(v) => set({ requiresSponsorship: v })} />
        <YesNo label="Security clearance" value={p.securityClearance ?? null} onChange={(v) => set({ securityClearance: v })} />
        <YesNo label="Willing to relocate" value={p.willingToRelocate ?? null} onChange={(v) => set({ willingToRelocate: v })} />
        <YesNo label="Willing remote" value={p.willingRemote ?? null} onChange={(v) => set({ willingRemote: v })} />
        <YesNo label="Willing onsite" value={p.willingOnsite ?? null} onChange={(v) => set({ willingOnsite: v })} />
      </div>

      {/* Diversity — optional EEO questions */}
      <div className="jp-subhead"><Icon name="target" size={14} /> Diversity <span className="faint">— optional, leave blank to decline</span></div>
      <div className="grid2">
        <Field label="Gender"><input className="input" placeholder="Male / Female / Decline" value={p.gender ?? ''} onChange={(e) => set({ gender: e.target.value })} /></Field>
        <Field label="Ethnicity"><input className="input" placeholder="Decline to self-identify" value={p.ethnicity ?? ''} onChange={(e) => set({ ethnicity: e.target.value })} /></Field>
        <Field label="Veteran status"><input className="input" placeholder="I am not a protected veteran" value={p.veteranStatus ?? ''} onChange={(e) => set({ veteranStatus: e.target.value })} /></Field>
        <Field label="Disability status"><input className="input" placeholder="I do not wish to answer" value={p.disabilityStatus ?? ''} onChange={(e) => set({ disabilityStatus: e.target.value })} /></Field>
        <YesNo label="Hispanic / Latino" value={p.hispanicLatino ?? null} onChange={(v) => set({ hispanicLatino: v })} />
      </div>

      {/* Skills experience (years) — with type-ahead skill suggestions */}
      <div className="jp-subhead"><Icon name="bolt" size={14} /> Skills experience (years) <span className="faint">— "how many years of X"</span></div>
      <datalist id="skill-suggest">{skillOptions(p.skills).map((s) => <option key={s} value={s} />)}</datalist>
      {skillRows.map((r, i) => (
        <div className="row" style={{ gap: 8, marginBottom: 8 }} key={i}>
          <input className="input" list="skill-suggest" style={{ flex: 1 }} placeholder="Start typing a skill…"
            value={r.k} onChange={(e) => setSkillRows((rs) => rs.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
          <input className="input" style={{ width: 96 }} inputMode="numeric" placeholder="years"
            value={r.v} onChange={(e) => setSkillRows((rs) => rs.map((x, j) => j === i ? { ...x, v: e.target.value.replace(/[^0-9.]/g, '') } : x))} />
          <button className="btn btn-ghost btn-sm" title="Remove" onClick={() => setSkillRows((rs) => rs.filter((_, j) => j !== i))}><Icon name="trash" size={13} /></button>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => setSkillRows((rs) => [...rs, { k: '', v: '' }])}><Icon name="plus" size={13} /> Add skill</button>

      {/* Custom screening answers — the yes/no questions forms ask, answered once + reused */}
      <div className="jp-subhead"><Icon name="clipboard" size={14} /> Custom screening answers</div>
      <div className="grid2" style={{ marginBottom: 10 }}>
        <Field label="Years of professional experience"><input className="input" placeholder="1" value={p.yearsExperience ?? ''} onChange={(e) => set({ yearsExperience: e.target.value })} /></Field>
        <Field label="Notice period (days)"><input className="input" placeholder="15" value={p.noticePeriod ?? ''} onChange={(e) => set({ noticePeriod: e.target.value })} /></Field>
      </div>
      {qaRows.map((r, i) => (
        <div className="row" style={{ gap: 8, marginBottom: 8, alignItems: 'flex-start' }} key={i}>
          <input className="input" style={{ flex: 1 }} placeholder="Question (e.g. Do you have a non-compete agreement?)"
            value={r.k} onChange={(e) => setQaRows((rs) => rs.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
          <input className="input" style={{ width: 130 }} placeholder="Answer"
            value={r.v} onChange={(e) => setQaRows((rs) => rs.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} />
          <button className="btn btn-ghost btn-sm" title="Remove" onClick={() => setQaRows((rs) => rs.filter((_, j) => j !== i))}><Icon name="trash" size={13} /></button>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-sm" onClick={() => setQaRows((rs) => [...rs, { k: '', v: '' }])}><Icon name="plus" size={13} /> Add question</button>
        <button className="btn btn-sm" onClick={() => setQaRows((rs) => mergeCommonScreening(rs))}>Add common questions</button>
      </div>

      {/* Projects & achievements are the SAME profile record as the main Profile page — edited
          there to avoid duplication. Both the job profile and the main profile feed applications. */}
      <div className="jp-subhead"><Icon name="trophy" size={14} /> Projects &amp; achievements</div>
      <div className="faint" style={{ fontSize: 12.5, marginBottom: 4 }}>
        Managed in your <a href="/profile">Profile</a> — they're shared, so anything there is used
        when applying (the job profile and your profile are one record).
      </div>

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
      <Select value={value == null ? '' : value ? 'yes' : 'no'}
        onChange={(v) => onChange(v === '' ? null : v === 'yes')}
        options={[{ value: '', label: 'Select…' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />
    </label>
  );
}

/** work_authorization is stored as a "Yes"/"No" string; map it to a tri-state boolean. */
function boolOf(s?: string): boolean | null {
  if (!s) return null;
  return /^y/i.test(s) ? true : /^n/i.test(s) ? false : null;
}

// Type-ahead suggestions for the per-skill years inputs (the browser filters as you type,
// including partial matches). The owner's own skills are merged in first.
const SKILL_SUGGESTIONS = [
  'JavaScript', 'TypeScript', 'Python', 'Java', 'C', 'C++', 'C#', 'Go', 'Rust', 'Kotlin', 'Swift', 'PHP', 'Ruby', 'SQL',
  'React', 'React.js', 'Next.js', 'Vue', 'Angular', 'Svelte', 'Redux', 'HTML5', 'CSS3', 'TailwindCSS', 'Bootstrap', 'Vite',
  'Node.js', 'Express.js', 'Spring Boot', 'Spring Security', 'Spring Data JPA', 'Hibernate', 'Django', 'Flask', 'FastAPI', '.NET',
  'REST APIs', 'GraphQL', 'gRPC', 'Microservices', 'Distributed Systems', 'System Design', 'API Design',
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch', 'Kafka', 'RabbitMQ',
  'AWS', 'GCP', 'Azure', 'Docker', 'Kubernetes', 'Terraform', 'Jenkins', 'GitHub Actions', 'CI/CD', 'Linux', 'Git', 'Maven',
  'JUnit', 'Jest', 'Cypress', 'Postman', 'Agile', 'Scrum',
  'Keycloak', 'OAuth2', 'OIDC', 'JWT', 'IAM', 'OWASP', 'Secure Coding',
  'Prompt Engineering', 'LLM Integration', 'AI Application Development', 'Machine Learning', 'TensorFlow', 'PyTorch',
];
function skillOptions(userSkills?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...(userSkills ?? []), ...SKILL_SUGGESTIONS]) {
    const k = s.trim();
    if (k && !seen.has(k.toLowerCase())) { seen.add(k.toLowerCase()); out.push(k); }
  }
  return out;
}

// The screening questions almost every Easy-Apply form asks — added on demand, pre-answered "No".
const COMMON_SCREENING: Row[] = [
  { k: 'Have you previously worked for this company or its affiliates?', v: 'No' },
  { k: 'Are you a current employee of this company?', v: 'No' },
  { k: 'Do you have a non-compete agreement?', v: 'No' },
  { k: 'Do you have a criminal record or conflict of interest?', v: 'No' },
  { k: 'Are you related to any current employee?', v: 'No' },
];
function mergeCommonScreening(rows: Row[]): Row[] {
  const have = new Set(rows.map((r) => r.k.trim().toLowerCase()));
  return [...rows, ...COMMON_SCREENING.filter((c) => !have.has(c.k.toLowerCase()))];
}
