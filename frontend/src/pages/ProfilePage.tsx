import { useEffect, useState } from 'react';
import { api, type QaPair, type DocItem } from '../api/client';
import type { CertificationItem, EducationItem, ExperienceItem, Profile } from '../types';
import { fmtDate, useToast } from '../lib/ui';
import { Modal } from '../components/Modal';
import { TagInput } from '../components/TagInput';
import { SKILL_SUGGESTIONS, LANGUAGE_SUGGESTIONS, GENDER_OPTIONS, NOTICE_OPTIONS, WORK_AUTH_OPTIONS, COUNTRY_SUGGESTIONS } from '../lib/options';

/** Questions the extension saved (you clicked "Save" on a form). Listed + deletable here. */
function SavedAnswers() {
  const toast = useToast();
  const [items, setItems] = useState<QaPair[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftQ, setDraftQ] = useState('');
  const [draftA, setDraftA] = useState('');
  const load = () => api.qaList().then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, []);
  const remove = async (it: QaPair) => {
    if (!window.confirm('Delete this saved answer?')) return;
    setBusy(it.id);
    try { await api.qaDelete(it.id); setItems((x) => (x ?? []).filter((i) => i.id !== it.id)); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  const startEdit = (it: QaPair) => { setEditing(it.id); setDraftQ(it.question); setDraftA(it.answer); };
  const saveEdit = async (it: QaPair) => {
    if (!draftQ.trim() || !draftA.trim()) { toast('Question and answer are required', 'error'); return; }
    setBusy(it.id);
    try {
      const updated = await api.qaUpdate(it.id, { question: draftQ.trim(), answer: draftA.trim() });
      setItems((x) => (x ?? []).map((i) => (i.id === it.id ? updated : i)));
      setEditing(null);
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  return (
    <Section ico="💬" title="Saved from the extension" sub="questions you clicked “Save” on while applying — reused to autofill matching forms">
      {items === null ? <div className="empty"><span className="spinner" /></div>
        : items.length === 0 ? (
          <div className="faint" style={{ fontSize: 13 }}>
            Nothing saved yet. On an application form, click the extension's <b>💾 Save</b> under a question to keep its answer here.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {items.map((it) => (
              <div key={it.id} className="repeat-row" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {editing === it.id ? (
                  <>
                    <input className="input" value={draftQ} onChange={(e) => setDraftQ(e.target.value)} placeholder="Question" />
                    <textarea className="input" rows={2} value={draftA} onChange={(e) => setDraftA(e.target.value)} placeholder="Answer" />
                    <div className="row" style={{ gap: 8 }}>
                      <button className="btn btn-primary btn-sm" disabled={busy === it.id} onClick={() => saveEdit(it)}>Save</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{it.question}</div>
                      <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => startEdit(it)} title="Edit">✏️</button>
                        <button className="btn btn-ghost btn-sm" disabled={busy === it.id} onClick={() => remove(it)}
                          style={{ color: 'var(--danger,#ef4444)' }} title="Delete">🗑</button>
                      </div>
                    </div>
                    <div className="muted" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{it.answer}</div>
                    {it.updatedAt && <div className="faint" style={{ fontSize: 11 }}>Saved {fmtDate(it.updatedAt)}</div>}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
    </Section>
  );
}

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
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    api.profile().then(setP).catch((e) => toast(e.message, 'error'));
  }, []); // eslint-disable-line

  if (!p) return <div className="empty"><span className="spinner" /></div>;

  const set = (patch: Partial<Profile>) => setP({ ...p, ...patch });
  const setLink = (k: string, v: string) => setP({ ...p, links: { ...(p.links ?? {}), [k]: v } });

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.saveProfile(p);
      setP(saved);
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
      toast('Resume analyzed — fields auto-filled. Review & save.', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setAnalyzing(false); }
  };

  const suggest = async (field: string, current: string, apply: (v: string) => void) => {
    try {
      const ctx = `Name: ${p.fullName}; Headline: ${p.headline ?? ''}; Skills: ${(p.skills ?? []).join(', ')}`;
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
              <Field label="Date of birth"><input className="input" type="date" value={p.dateOfBirth ?? ''} onChange={(e) => set({ dateOfBirth: e.target.value })} /></Field>
              <Field label="Gender">
                <select className="select" value={p.gender ?? ''} onChange={(e) => set({ gender: e.target.value })}>
                  <option value="">Select…</option>
                  {GENDER_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </Field>
              <Field label="Nationality">
                <input className="input" list="nationality-list" value={p.nationality ?? ''} onChange={(e) => set({ nationality: e.target.value })} placeholder="Indian" />
                <datalist id="nationality-list">{COUNTRY_SUGGESTIONS.map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field label="Alternate phone"><input className="input" value={p.alternatePhone ?? ''} onChange={(e) => set({ alternatePhone: e.target.value })} placeholder="optional second number" /></Field>
              <Field label="Marital status">
                <select className="select" value={p.maritalStatus ?? ''} onChange={(e) => set({ maritalStatus: e.target.value })}>
                  <option value="">Select…</option>
                  <option>Single</option><option>Married</option><option>Prefer not to say</option>
                </select>
              </Field>
              <Field label="Father's name"><input className="input" value={p.fatherName ?? ''} onChange={(e) => set({ fatherName: e.target.value })} placeholder="asked on many Indian forms" /></Field>
              <Field label="Disability status">
                <select className="select" value={p.disabilityStatus ?? ''} onChange={(e) => set({ disabilityStatus: e.target.value })}>
                  <option value="">Select…</option>
                  <option>No</option><option>Yes</option><option>Prefer not to say</option>
                </select>
              </Field>
            </div>
          </Section>

          <Section ico="📍" title="Current address">
            <div className="grid3">
              <Field label="Current location (short)"><input className="input" value={p.location ?? ''} onChange={(e) => set({ location: e.target.value })} placeholder="Bengaluru" /></Field>
              <Field label="City"><input className="input" value={p.city ?? ''} onChange={(e) => set({ city: e.target.value })} placeholder="Bengaluru" /></Field>
              <Field label="State / Province"><input className="input" value={p.state ?? ''} onChange={(e) => set({ state: e.target.value })} placeholder="Karnataka" /></Field>
              <Field label="Country"><input className="input" list="nationality-list" value={p.country ?? ''} onChange={(e) => set({ country: e.target.value })} placeholder="India" /></Field>
              <Field label="Postal / PIN code"><input className="input" inputMode="numeric" value={p.postalCode ?? ''} onChange={(e) => set({ postalCode: e.target.value })} placeholder="560001" /></Field>
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
              <Field label="LeetCode / DSA profile"><input className="input" placeholder="https://leetcode.com/username/" value={p.links?.leetcode ?? ''} onChange={(e) => setLink('leetcode', e.target.value)} /></Field>
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
              <Field label="Total experience (yrs)"><input className="input" type="number" min="0" step="0.5" placeholder="3.5" value={p.yearsExperience ?? ''} onChange={(e) => set({ yearsExperience: e.target.value })} /></Field>
              <Field label="College / University"><input className="input" placeholder="KL University" value={p.college ?? ''} onChange={(e) => set({ college: e.target.value })} /></Field>
              <Field label="Current CTC"><input className="input" placeholder="4 LPA" value={p.currentCtc ?? ''} onChange={(e) => set({ currentCtc: e.target.value })} /></Field>
              <Field label="Expected CTC"><input className="input" placeholder="8 LPA" value={p.expectedCtc ?? ''} onChange={(e) => set({ expectedCtc: e.target.value })} /></Field>
              <Field label="Notice period">
                <input className="input" list="notice-list" placeholder="30 days" value={p.noticePeriod ?? ''} onChange={(e) => set({ noticePeriod: e.target.value })} />
                <datalist id="notice-list">{NOTICE_OPTIONS.map((n) => <option key={n} value={n} />)}</datalist>
              </Field>
              <Field label="Available from"><input className="input" type="date" value={p.availableFrom ?? ''} onChange={(e) => set({ availableFrom: e.target.value })} /></Field>
            </div>
          </Section>

          <Section ico="✅" title="Work eligibility & preferences">
            <div className="grid3">
              <Field label="Work authorization">
                <input className="input" list="workauth-list" placeholder="Indian citizen" value={p.workAuthorization ?? ''} onChange={(e) => set({ workAuthorization: e.target.value })} />
                <datalist id="workauth-list">{WORK_AUTH_OPTIONS.map((w) => <option key={w} value={w} />)}</datalist>
              </Field>
              <Field label="Requires sponsorship"><TriSelect value={p.requiresSponsorship} onChange={(v) => set({ requiresSponsorship: v })} /></Field>
              <Field label="Willing to relocate"><TriSelect value={p.willingToRelocate} onChange={(v) => set({ willingToRelocate: v })} /></Field>
              <Field label="Preferred locations" full><TagInput value={p.preferredLocations ?? []} onChange={(v) => set({ preferredLocations: v })} placeholder="Bengaluru, Remote, Hyderabad…" /></Field>
              <Field label="Languages" full><TagInput value={p.languages ?? []} onChange={(v) => set({ languages: v })} suggestions={LANGUAGE_SUGGESTIONS} placeholder="English, Hindi…" /></Field>
            </div>
          </Section>

          <Section ico="🧩" title="Skills" sub="type to search, Enter to add, × to remove">
            <TagInput value={p.skills ?? []} onChange={(v) => set({ skills: v })} suggestions={SKILL_SUGGESTIONS} placeholder="Start typing a skill — e.g. Java, React, Docker…" />
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
                  <Field label="Start"><input className="input" type="month" value={item.start ?? ''} onChange={(e) => upd({ start: e.target.value })} /></Field>
                  <Field label="End (blank = present)"><input className="input" type="month" value={item.end ?? ''} onChange={(e) => upd({ end: e.target.value })} /></Field>
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
            empty={{ name: '', issuer: '', year: '', link: '', credentialId: '', issued: '', expiry: '' }}
            render={(item, upd) => (
              <>
                <div className="grid3">
                  <Field label="Name"><input className="input" value={item.name ?? ''} onChange={(e) => upd({ name: e.target.value })} /></Field>
                  <Field label="Issuer"><input className="input" value={item.issuer ?? ''} onChange={(e) => upd({ issuer: e.target.value })} /></Field>
                  <Field label="Credential / certificate no."><input className="input" placeholder="ABC-1234" value={item.credentialId ?? ''} onChange={(e) => upd({ credentialId: e.target.value })} /></Field>
                  <Field label="Issued"><input className="input" type="month" value={item.issued ?? ''} onChange={(e) => upd({ issued: e.target.value })} /></Field>
                  <Field label="Expiry (blank = never)"><input className="input" type="month" value={item.expiry ?? ''} onChange={(e) => upd({ expiry: e.target.value })} /></Field>
                  <Field label="Year (legacy)"><input className="input" value={item.year ?? ''} onChange={(e) => upd({ year: e.target.value })} /></Field>
                </div>
                <Field label="Credential link"><input className="input" placeholder="https://credential.url/…" value={item.link ?? ''} onChange={(e) => upd({ link: e.target.value })} /></Field>
                <div className="faint" style={{ fontSize: 12 }}>Drop the certificate file in the <b>Resume → Document vault</b> tab (drag &amp; drop supported).</div>
              </>
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
          <SavedAnswers />
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
          <DocumentsVault />
        </div>
      )}
    </>
  );
}

const DOC_TYPES = ['certificate', 'transcript', 'id-proof', 'offer-letter', 'experience-letter', 'cover-letter', 'other'];

/** Encrypted document vault: upload, list, password-gated download, delete. */
function DocumentsVault() {
  const toast = useToast();
  const [docs, setDocs] = useState<DocItem[] | null>(null);
  const [type, setType] = useState('certificate');
  const [busy, setBusy] = useState(false);
  const [pwFor, setPwFor] = useState<DocItem | null>(null);
  const [pw, setPw] = useState('');

  const load = () => api.docList().then(setDocs).catch(() => setDocs([]));
  useEffect(() => { load(); }, []);

  const [dragOver, setDragOver] = useState(false);

  const upload = async (files?: FileList | File[] | null) => {
    const list = [...(files ?? [])];
    if (!list.length) return;
    setBusy(true);
    try {
      for (const file of list) await api.docUpload(file, file.name, type);
      toast(`Uploaded & encrypted ${list.length === 1 ? '✓' : `${list.length} files ✓`}`, 'success');
      load();
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const remove = async (d: DocItem) => {
    if (!window.confirm(`Delete "${d.name}"? This can't be undone.`)) return;
    try { await api.docDelete(d.id); toast('Deleted', 'success'); setDocs((x) => (x ?? []).filter((i) => i.id !== d.id)); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const doDownload = async () => {
    if (!pwFor || !pw) return;
    setBusy(true);
    try {
      const blob = await api.docDownload(pwFor.id, pw);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = pwFor.filename || pwFor.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('Download started ✓', 'success');
      setPwFor(null); setPw('');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const kb = (n?: number) => (n ? `${Math.max(1, Math.round(n / 1024))} KB` : '');

  return (
    <Section ico="🔐" title="Document vault" sub="encrypted at rest · download asks for your password">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select className="select" value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 200 }}>
          {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="btn btn-primary btn-sm">
          {busy ? <span className="spinner" /> : '⬆'} Upload document(s)
          <input type="file" multiple style={{ display: 'none' }} disabled={busy} onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
        </label>
      </div>

      {/* Drag & drop: certificates, ID proofs, transcripts, extra resumes — any files. */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files); }}
        style={{
          border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
          background: dragOver ? 'var(--accent-soft)' : 'transparent',
          borderRadius: 12, padding: '18px 14px', textAlign: 'center',
          fontSize: 13, color: 'var(--text-dim)', marginBottom: 12, transition: 'all .15s',
        }}>
        {busy ? <span className="spinner" /> : <>📥 Drag &amp; drop files here — stored as “<b>{type}</b>”</>}
      </div>

      {docs === null ? <div className="empty"><span className="spinner" /></div>
        : docs.length === 0 ? <div className="faint" style={{ fontSize: 13 }}>No documents yet. Upload certificates, transcripts, ID proofs, etc.</div>
        : (
          <div style={{ display: 'grid', gap: 8 }}>
            {docs.map((d) => (
              <div key={d.id} className="repeat-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</div>
                  <div className="faint" style={{ fontSize: 12 }}>{d.type} · {kb(d.sizeBytes)}{d.createdAt ? ` · ${fmtDate(d.createdAt)}` : ''}</div>
                </div>
                <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                  <button className="btn btn-sm" onClick={() => { setPwFor(d); setPw(''); }}>⬇ Download</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => remove(d)} style={{ color: 'var(--danger,#ef4444)' }}>🗑</button>
                </div>
              </div>
            ))}
          </div>
        )}

      {pwFor && (
        <Modal title="Confirm your password to download" onClose={() => setPwFor(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setPwFor(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={doDownload} disabled={busy || !pw}>{busy ? <span className="spinner" /> : '⬇'} Download</button>
          </>}>
          <div className="faint" style={{ fontSize: 13, marginBottom: 10 }}>
            “{pwFor.name}” is encrypted. Enter your account password to decrypt and download it.
          </div>
          <input className="input" type="password" autoFocus value={pw} placeholder="Account password"
            onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') doDownload(); }} />
        </Modal>
      )}
    </Section>
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
