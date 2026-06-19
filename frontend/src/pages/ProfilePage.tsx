import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { CertificationItem, EducationItem, ExperienceItem, Profile } from '../types';
import { useToast } from '../lib/ui';

type Tab = 'personal' | 'professional' | 'experience' | 'education' | 'autofill' | 'resume';
const TABS: { id: Tab; label: string; ico: string }[] = [
  { id: 'personal', label: 'Personal', ico: '👤' },
  { id: 'professional', label: 'Professional', ico: '💼' },
  { id: 'experience', label: 'Experience', ico: '🏢' },
  { id: 'education', label: 'Education', ico: '🎓' },
  { id: 'autofill', label: 'Autofill answers', ico: '⚡' },
  { id: 'resume', label: 'Resume', ico: '📄' },
];

export function ProfilePage() {
  const toast = useToast();
  const [p, setP] = useState<Profile | null>(null);
  const [tab, setTab] = useState<Tab>('personal');
  const [skillsText, setSkillsText] = useState('');
  const [prefLocText, setPrefLocText] = useState('');
  const [langText, setLangText] = useState('');
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    api.profile().then((prof) => {
      setP(prof);
      setSkillsText((prof.skills ?? []).join(', '));
      setPrefLocText((prof.preferredLocations ?? []).join(', '));
      setLangText((prof.languages ?? []).join(', '));
    }).catch((e) => toast(e.message, 'error'));
  }, []); // eslint-disable-line

  if (!p) return <div className="empty"><span className="spinner" /></div>;

  const set = (patch: Partial<Profile>) => setP({ ...p, ...patch });
  const setLink = (k: string, v: string) => setP({ ...p, links: { ...(p.links ?? {}), [k]: v } });
  const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  const save = async () => {
    setSaving(true);
    try {
      const body: Profile = {
        ...p,
        skills: csv(skillsText),
        preferredLocations: csv(prefLocText),
        languages: csv(langText),
      };
      const saved = await api.saveProfile(body);
      setP(saved);
      setSkillsText((saved.skills ?? []).join(', '));
      toast('Profile saved', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setSaving(false); }
  };

  const onResume = async (file?: File) => {
    if (!file) return;
    try { const r = await api.uploadResume(file); set({ resumeFilename: r.filename }); toast('Resume uploaded', 'success'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const onAnalyze = async (file?: File) => {
    if (!file) return;
    setAnalyzing(true);
    try {
      const saved = await api.analyzeResume(file);
      setP(saved);
      setSkillsText((saved.skills ?? []).join(', '));
      setPrefLocText((saved.preferredLocations ?? []).join(', '));
      setLangText((saved.languages ?? []).join(', '));
      toast('Resume analyzed — fields auto-filled. Review & save.', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setAnalyzing(false); }
  };

  const suggest = async (field: string, current: string, apply: (v: string) => void) => {
    try {
      const ctx = `Name: ${p.fullName}; Headline: ${p.headline ?? ''}; Skills: ${(skillsText)}`;
      const r = await api.aiSuggest(field, current, ctx);
      apply(r.suggestion);
      toast('Suggestion applied — edit as needed', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Profile</h1>
          <div className="page-sub">Everything below feeds job matching, cover letters & extension autofill</div>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? <span className="spinner" /> : '💾'} Save all</button>
      </div>

      {(() => {
        const checks = [p.fullName, p.email, p.phone, p.headline, p.location, p.summary,
          (p.skills ?? []).length > 0, (p.experience ?? []).length > 0, (p.education ?? []).length > 0,
          p.resumeFilename, p.expectedCtc, p.links?.github];
        const done = checks.filter(Boolean).length;
        const pct = Math.round((done / checks.length) * 100);
        return (
          <div className="card card-pad profile-hero">
            <div className="hero-avatar">{(p.fullName?.[0] ?? 'U').toUpperCase()}</div>
            <div className="grow">
              <div className="hero-name">{p.fullName || 'Your Name'}</div>
              <div className="muted" style={{ fontSize: 13 }}>{p.headline || 'Add a headline'} · {p.location || 'location'}</div>
              <div className="skill-row" style={{ marginTop: 8 }}>
                <span className="chip">🧩 {(p.skills ?? []).length} skills</span>
                <span className="chip">💼 {p.yearsExperience || '0'} yrs</span>
                <span className="chip">{p.resumeFilename ? '📄 resume ✓' : '📄 no resume'}</span>
              </div>
            </div>
            <div className="hero-pct">
              <div className="hero-pct-num">{pct}%</div>
              <div className="hero-pct-label">complete</div>
              <div className="score-bar" style={{ width: 90, marginTop: 6 }}><span style={{ width: `${pct}%` }} /></div>
            </div>
          </div>
        );
      })()}

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.ico} {t.label}</div>
        ))}
      </div>

      {tab === 'personal' && (
        <div style={{ maxWidth: 900 }}>
          <Section ico="👤" title="Identity">
            <div className="grid3">
              <Field label="Full name"><input className="input" value={p.fullName ?? ''} onChange={(e) => set({ fullName: e.target.value })} /></Field>
              <Field label="First name"><input className="input" value={p.firstName ?? ''} onChange={(e) => set({ firstName: e.target.value })} /></Field>
              <Field label="Last name"><input className="input" value={p.lastName ?? ''} onChange={(e) => set({ lastName: e.target.value })} /></Field>
              <Field label="Email"><input className="input" value={p.email ?? ''} onChange={(e) => set({ email: e.target.value })} /></Field>
              <Field label="Phone"><input className="input" value={p.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} /></Field>
              <Field label="Headline"><input className="input" placeholder="Backend Engineer" value={p.headline ?? ''} onChange={(e) => set({ headline: e.target.value })} /></Field>
              <Field label="Date of birth"><input className="input" placeholder="YYYY-MM-DD" value={p.dateOfBirth ?? ''} onChange={(e) => set({ dateOfBirth: e.target.value })} /></Field>
              <Field label="Gender"><input className="input" value={p.gender ?? ''} onChange={(e) => set({ gender: e.target.value })} /></Field>
              <Field label="Nationality"><input className="input" value={p.nationality ?? ''} onChange={(e) => set({ nationality: e.target.value })} /></Field>
            </div>
          </Section>

          <Section ico="📍" title="Current address">
            <div className="grid3">
              <Field label="Current location (short)"><input className="input" value={p.location ?? ''} onChange={(e) => set({ location: e.target.value })} placeholder="Bengaluru" /></Field>
              <Field label="City"><input className="input" value={p.city ?? ''} onChange={(e) => set({ city: e.target.value })} placeholder="Bengaluru" /></Field>
              <Field label="State / Province"><input className="input" value={p.state ?? ''} onChange={(e) => set({ state: e.target.value })} placeholder="Karnataka" /></Field>
              <Field label="Country"><input className="input" value={p.country ?? ''} onChange={(e) => set({ country: e.target.value })} placeholder="India" /></Field>
              <Field label="Postal / PIN code"><input className="input" value={p.postalCode ?? ''} onChange={(e) => set({ postalCode: e.target.value })} placeholder="560001" /></Field>
              <Field label="Street address" full><input className="input" value={p.address ?? ''} onChange={(e) => set({ address: e.target.value })} placeholder="Flat / street / area" /></Field>
            </div>
          </Section>

          <Section ico="🏠" title="Permanent / alternate address" sub="used when a form asks for a second address">
            <div className="grid3">
              <Field label="Location (short)"><input className="input" value={p.location2 ?? ''} onChange={(e) => set({ location2: e.target.value })} placeholder="home town" /></Field>
              <Field label="City"><input className="input" value={p.city2 ?? ''} onChange={(e) => set({ city2: e.target.value })} /></Field>
              <Field label="State / Province"><input className="input" value={p.state2 ?? ''} onChange={(e) => set({ state2: e.target.value })} /></Field>
              <Field label="Country"><input className="input" value={p.country2 ?? ''} onChange={(e) => set({ country2: e.target.value })} /></Field>
              <Field label="Postal / PIN code"><input className="input" value={p.postalCode2 ?? ''} onChange={(e) => set({ postalCode2: e.target.value })} /></Field>
              <Field label="Street address" full><input className="input" value={p.address2 ?? ''} onChange={(e) => set({ address2: e.target.value })} /></Field>
            </div>
          </Section>

          <Section ico="🔗" title="Links">
            <div className="grid3">
              <Field label="GitHub"><input className="input" value={p.links?.github ?? ''} onChange={(e) => setLink('github', e.target.value)} /></Field>
              <Field label="LinkedIn"><input className="input" value={p.links?.linkedin ?? ''} onChange={(e) => setLink('linkedin', e.target.value)} /></Field>
              <Field label="Portfolio"><input className="input" value={p.links?.portfolio ?? ''} onChange={(e) => setLink('portfolio', e.target.value)} /></Field>
            </div>
          </Section>
        </div>
      )}

      {tab === 'professional' && (
        <div style={{ maxWidth: 900 }}>
          <Section ico="💼" title="Current role & compensation">
            <div className="grid3">
              <Field label="Current title"><input className="input" value={p.currentTitle ?? ''} onChange={(e) => set({ currentTitle: e.target.value })} /></Field>
              <Field label="Current company"><input className="input" value={p.currentCompany ?? ''} onChange={(e) => set({ currentCompany: e.target.value })} /></Field>
              <Field label="Seniority">
                <select className="select" value={p.seniority ?? ''} onChange={(e) => set({ seniority: e.target.value })}>
                  <option value="">—</option><option value="entry">entry</option><option value="mid">mid</option><option value="senior">senior</option>
                </select>
              </Field>
              <Field label="Total experience (yrs)"><input className="input" placeholder="3.5" value={p.yearsExperience ?? ''} onChange={(e) => set({ yearsExperience: e.target.value })} /></Field>
              <Field label="Current CTC"><input className="input" value={p.currentCtc ?? ''} onChange={(e) => set({ currentCtc: e.target.value })} /></Field>
              <Field label="Expected CTC"><input className="input" value={p.expectedCtc ?? ''} onChange={(e) => set({ expectedCtc: e.target.value })} /></Field>
              <Field label="Notice period"><input className="input" placeholder="30 days" value={p.noticePeriod ?? ''} onChange={(e) => set({ noticePeriod: e.target.value })} /></Field>
              <Field label="Available from"><input className="input" placeholder="Immediate / 2026-08-01" value={p.availableFrom ?? ''} onChange={(e) => set({ availableFrom: e.target.value })} /></Field>
            </div>
          </Section>

          <Section ico="✅" title="Work eligibility & preferences">
            <div className="grid3">
              <Field label="Work authorization"><input className="input" placeholder="Indian citizen / H1B" value={p.workAuthorization ?? ''} onChange={(e) => set({ workAuthorization: e.target.value })} /></Field>
              <Field label="Requires sponsorship"><TriSelect value={p.requiresSponsorship} onChange={(v) => set({ requiresSponsorship: v })} /></Field>
              <Field label="Willing to relocate"><TriSelect value={p.willingToRelocate} onChange={(v) => set({ willingToRelocate: v })} /></Field>
              <Field label="Preferred locations (comma-sep)" full><input className="input" value={prefLocText} onChange={(e) => setPrefLocText(e.target.value)} placeholder="Bengaluru, Remote, Hyderabad" /></Field>
              <Field label="Languages (comma-sep)" full><input className="input" value={langText} onChange={(e) => setLangText(e.target.value)} placeholder="English, Hindi, Telugu" /></Field>
            </div>
          </Section>

          <Section ico="🧩" title="Skills">
            <input className="input" value={skillsText} onChange={(e) => setSkillsText(e.target.value)} placeholder="java, spring, postgres, react" />
            <div className="skill-row" style={{ marginTop: 10 }}>
              {csv(skillsText).map((s) => <span key={s} className="chip">{s}</span>)}
            </div>
          </Section>

          <Section ico="📝" title="Summary & cover-letter notes" sub="used by the LLM cover-letter generator">
            <label className="field full">
              <div className="row" style={{ justifyContent: 'space-between' }}><span>Professional summary</span>
                <button className="btn btn-ghost ai-suggest-btn" onClick={() => suggest('professional summary', p.summary ?? '', (v) => set({ summary: v }))}>✨ AI suggest</button>
              </div>
              <textarea className="input" rows={4} value={p.summary ?? ''} onChange={(e) => set({ summary: e.target.value })} />
            </label>
            <Field label="Cover-letter style/notes (optional)" full><textarea className="input" rows={3} value={p.coverLetterTemplate ?? ''} onChange={(e) => set({ coverLetterTemplate: e.target.value })} placeholder="Tone, things to emphasize, custom intro…" /></Field>
          </Section>
        </div>
      )}

      {tab === 'experience' && (
        <div style={{ maxWidth: 820 }}>
          <RepeatableList<ExperienceItem>
            ico="🏢" title="Work experience"
            items={p.experience ?? []}
            onChange={(items) => set({ experience: items })}
            empty={{ company: '', title: '', start: '', end: '', description: '' }}
            render={(item, upd) => (
              <>
                <div className="grid2">
                  <Field label="Company"><input className="input" value={item.company ?? ''} onChange={(e) => upd({ company: e.target.value })} /></Field>
                  <Field label="Title"><input className="input" value={item.title ?? ''} onChange={(e) => upd({ title: e.target.value })} /></Field>
                  <Field label="Start"><input className="input" placeholder="2022-01" value={item.start ?? ''} onChange={(e) => upd({ start: e.target.value })} /></Field>
                  <Field label="End"><input className="input" placeholder="Present" value={item.end ?? ''} onChange={(e) => upd({ end: e.target.value })} /></Field>
                </div>
                <Field label="Description" full><textarea className="input" rows={2} value={item.description ?? ''} onChange={(e) => upd({ description: e.target.value })} /></Field>
              </>
            )}
          />
        </div>
      )}

      {tab === 'education' && (
        <div style={{ maxWidth: 820 }}>
          <RepeatableList<EducationItem>
            ico="🎓" title="Education"
            items={p.education ?? []}
            onChange={(items) => set({ education: items })}
            empty={{ school: '', degree: '', field: '', year: '' }}
            render={(item, upd) => (
              <div className="grid2">
                <Field label="School / University"><input className="input" value={item.school ?? ''} onChange={(e) => upd({ school: e.target.value })} /></Field>
                <Field label="Degree"><input className="input" value={item.degree ?? ''} onChange={(e) => upd({ degree: e.target.value })} /></Field>
                <Field label="Field of study"><input className="input" value={item.field ?? ''} onChange={(e) => upd({ field: e.target.value })} /></Field>
                <Field label="Year"><input className="input" value={item.year ?? ''} onChange={(e) => upd({ year: e.target.value })} /></Field>
              </div>
            )}
          />
          <RepeatableList<CertificationItem>
            ico="📜" title="Certifications"
            items={p.certifications ?? []}
            onChange={(items) => set({ certifications: items })}
            empty={{ name: '', issuer: '', year: '' }}
            render={(item, upd) => (
              <div className="grid3">
                <Field label="Name"><input className="input" value={item.name ?? ''} onChange={(e) => upd({ name: e.target.value })} /></Field>
                <Field label="Issuer"><input className="input" value={item.issuer ?? ''} onChange={(e) => upd({ issuer: e.target.value })} /></Field>
                <Field label="Year"><input className="input" value={item.year ?? ''} onChange={(e) => upd({ year: e.target.value })} /></Field>
              </div>
            )}
          />
        </div>
      )}

      {tab === 'autofill' && (
        <div style={{ maxWidth: 760 }}>
          <Section ico="⚡" title="Custom autofill answers" sub="label keyword → answer; the extension matches these on any form">
            <KeyValueEditor map={p.fieldMap ?? {}} onChange={(m) => set({ fieldMap: m })} />
            <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
              Example: <code>why this company</code> → your standard answer, or <code>github</code> → your URL.
              These take priority over the built-in field matching.
            </div>
          </Section>
        </div>
      )}

      {tab === 'resume' && (
        <div style={{ maxWidth: 620 }}>
          <Section ico="📄" title="Resume" sub="attached to email-apply jobs">
            <div className="row">
              <span className="muted">{p.resumeFilename ? `📄 ${p.resumeFilename}` : 'No resume uploaded'}</span>
              <label className="btn btn-sm">Upload only
                <input type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }} onChange={(e) => onResume(e.target.files?.[0])} />
              </label>
            </div>
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>✨ Smart auto-fill</div>
              <div className="faint" style={{ fontSize: 12, marginBottom: 10 }}>
                Upload a PDF/DOCX resume and AI extracts your name, contact, skills, experience &
                education — then fills and saves the profile. You review and tweak.
              </div>
              <label className="btn btn-primary btn-sm">
                {analyzing ? <span className="spinner" /> : '⚡'} Analyze resume & auto-fill
                <input type="file" accept=".pdf,.docx" style={{ display: 'none' }} disabled={analyzing} onChange={(e) => onAnalyze(e.target.files?.[0])} />
              </label>
            </div>
          </Section>
        </div>
      )}
    </>
  );
}

/* ---- small building blocks ---- */
function Section({ ico, title, sub, children }: { ico: string; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="card card-pad section">
      <div className="section-title"><span className="si">{ico}</span>{title}{sub && <span className="section-sub">{sub}</span>}</div>
      {children}
    </div>
  );
}
function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return <label className={`field ${full ? 'full' : ''}`}>{label}{children}</label>;
}
function TriSelect({ value, onChange }: { value?: boolean | null; onChange: (v: boolean | null) => void }) {
  const v = value === true ? 'yes' : value === false ? 'no' : '';
  return (
    <select className="select" value={v} onChange={(e) => onChange(e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null)}>
      <option value="">—</option><option value="yes">Yes</option><option value="no">No</option>
    </select>
  );
}

function RepeatableList<T>({
  ico, title, items, onChange, render, empty,
}: {
  ico: string; title: string; items: T[]; onChange: (items: T[]) => void;
  render: (item: T, upd: (patch: Partial<T>) => void) => React.ReactNode; empty: T;
}) {
  const upd = (i: number, patch: Partial<T>) => onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  return (
    <Section ico={ico} title={title}>
      {items.length === 0 && <div className="faint" style={{ marginBottom: 10 }}>None yet.</div>}
      {items.map((item, i) => (
        <div className="repeat-row" key={i}>
          <div className="rh"><span className="muted" style={{ fontSize: 12 }}>#{i + 1}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => remove(i)}>✕ Remove</button></div>
          {render(item, (patch) => upd(i, patch))}
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => onChange([...items, { ...empty }])}>+ Add</button>
    </Section>
  );
}

function KeyValueEditor({ map, onChange }: { map: Record<string, string>; onChange: (m: Record<string, string>) => void }) {
  const entries = Object.entries(map);
  const setKey = (oldK: string, newK: string) => {
    const next: Record<string, string> = {};
    entries.forEach(([k, v]) => { next[k === oldK ? newK : k] = v; });
    onChange(next);
  };
  const setVal = (k: string, v: string) => onChange({ ...map, [k]: v });
  const remove = (k: string) => { const n = { ...map }; delete n[k]; onChange(n); };
  return (
    <>
      {entries.map(([k, v]) => (
        <div className="kv-row" key={k}>
          <input className="input" value={k} onChange={(e) => setKey(k, e.target.value)} placeholder="question keyword" />
          <input className="input" value={v} onChange={(e) => setVal(k, e.target.value)} placeholder="answer" />
          <button className="btn btn-ghost btn-sm" onClick={() => remove(k)}>✕</button>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => onChange({ ...map, [`question ${entries.length + 1}`]: '' })}>+ Add answer</button>
    </>
  );
}
