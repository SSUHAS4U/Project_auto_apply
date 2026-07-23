import { useEffect, useState } from 'react';
import { api, type QaPair, type DocItem } from '../api/client';
import type { CertificationItem, EducationItem, ExperienceItem, Profile } from '../types';
import { fmtDate, useToast } from '../lib/ui';
import { Modal } from '../components/Modal';
import { Icon } from '../components/Icon';
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
  // Pending (blank-answer) questions first — those are the ones the automation hit and
  // needs YOU to answer once; after that they autofill forever.
  const load = () => api.qaList()
    .then((list) => setItems([...list].sort((a, b) =>
      Number(!!(a.answer && a.answer.trim())) - Number(!!(b.answer && b.answer.trim())))))
    .catch(() => setItems([]));
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
    <Section ico="clipboard" title="Saved from the extension" sub="questions you clicked “Save” on while applying — reused to autofill matching forms">
      {items === null ? <div className="empty"><span className="spinner" /></div>
        : items.length === 0 ? (
          <div className="faint" style={{ fontSize: 13 }}>
            Nothing saved yet. On an application form, click the extension's <b>Save</b> under a question to keep its answer here.
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
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                        {it.question}{' '}
                        {!(it.answer && it.answer.trim()) && <span className="tone tone-amber">needs your answer</span>}
                      </div>
                      <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => startEdit(it)} title="Edit"><Icon name="pen" size={13} /></button>
                        <button className="btn btn-ghost btn-sm" disabled={busy === it.id} onClick={() => remove(it)}
                          style={{ color: 'var(--danger,#ef4444)' }} title="Delete"><Icon name="trash" size={13} /></button>
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

type Tab = 'personal' | 'professional' | 'education' | 'autofill' | 'resume';
const TABS: { id: Tab; label: string; ico: string }[] = [
  { id: 'personal', label: 'Personal', ico: 'user' },
  { id: 'professional', label: 'Professional', ico: 'clipboard' },
  { id: 'education', label: 'Education', ico: 'file' },
  { id: 'autofill', label: 'Autofill answers', ico: 'bolt' },
  { id: 'resume', label: 'Resume', ico: 'file' },
];

export function ProfilePage() {
  const toast = useToast();
  const [p, setP] = useState<Profile | null>(null);
  const [tab, setTab] = useState<Tab>('personal');
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [sugging, setSugging] = useState('');

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
    setSugging(field);
    try {
      // Give the model the whole picture, not just the name — a headline written from the
      // role/company/experience is far better than one guessed from a name and skills.
      const ctx = [
        `Name: ${p.fullName ?? ''}`,
        `Current role: ${[p.currentTitle, p.currentCompany].filter(Boolean).join(' at ')}`,
        `Years of experience: ${p.yearsExperience ?? ''}`,
        `Location: ${p.location ?? ''}`,
        `Headline: ${p.headline ?? ''}`,
        `Skills: ${(p.skills ?? []).join(', ')}`,
      ].filter((l) => !l.endsWith(': ')).join('; ');
      const r = await api.aiSuggest(field, current, ctx);
      apply(r.suggestion);
      toast('Suggestion applied — edit as needed', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setSugging(''); }
  };

  /** The inline "Suggest" chip for a field's label row. */
  const sugBtn = (field: string, current: string, apply: (v: string) => void) => (
    <button type="button" className="pf-sug" disabled={sugging === field}
      title={`Let AI draft your ${field} from the rest of your profile`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); suggest(field, current, apply); }}>
      {sugging === field ? <span className="spinner" /> : <Icon name="sparkles" size={11} />} Suggest
    </button>
  );

  // Completeness: the fields that actually drive matching, cover letters and autofill.
  // Shown as a ring so an incomplete profile is obvious at a glance.
  const CHECKS: [string, boolean][] = [
    ['Full name', !!p.fullName], ['Email', !!p.email], ['Phone', !!p.phone],
    ['Headline', !!p.headline], ['Location', !!p.location], ['Summary', !!p.summary],
    ['Skills', (p.skills ?? []).length > 0], ['Experience', (p.experience ?? []).length > 0],
    ['Education', (p.education ?? []).length > 0], ['Resume', !!p.resumeFilename],
    ['Expected CTC', !!p.expectedCtc], ['GitHub link', !!p.links?.github],
  ];
  const missing = CHECKS.filter(([, ok]) => !ok).map(([k]) => k);
  const pct = Math.round(((CHECKS.length - missing.length) / CHECKS.length) * 100);

  return (
    <div className="pf">
      <div className="page-head">
        <div>
          <h1 className="page-title">Profile</h1>
          <div className="page-sub">Everything here feeds job matching, cover letters and the extension's autofill.</div>
        </div>
      </div>

      <div className="pf-head">
        <div className="pf-avatar">{(p.fullName?.[0] ?? 'U').toUpperCase()}</div>
        <div className="pf-id">
          <div className="pf-name">{p.fullName || 'Your name'}</div>
          <div className="pf-role">
            {p.headline || 'Add a headline'}{p.location ? ` · ${p.location}` : ''}
          </div>
          <div className="pf-pills">
            <span className="pf-pill"><Icon name="bolt" size={12} /> {(p.skills ?? []).length} skills</span>
            <span className="pf-pill"><Icon name="trophy" size={12} /> {p.yearsExperience || '0'} yrs</span>
            <span className={`pf-pill ${p.resumeFilename ? '' : 'warn'}`}>
              <Icon name={p.resumeFilename ? 'check' : 'alert'} size={12} /> {p.resumeFilename ? 'Résumé on file' : 'No résumé'}
            </span>
            {missing.length > 0 && (
              <span className="pf-pill warn" title={`Missing: ${missing.join(', ')}`}>
                <Icon name="alert" size={12} /> {missing.length} field{missing.length === 1 ? '' : 's'} left
              </span>
            )}
          </div>
        </div>
        <div className="pf-ring" style={{ ['--pct']: pct } as React.CSSProperties}
          title={missing.length ? `Missing: ${missing.join(', ')}` : 'Profile complete'}>
          <div className="pf-ring-in">
            <div className="pf-ring-n">{pct}%</div>
            <div className="pf-ring-l">done</div>
          </div>
        </div>
      </div>

      <div className="pf-nav" role="tablist" aria-label="Profile sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
            className={`pf-nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            <Icon name={t.ico} size={14} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'personal' && (
        <div>
          <Section ico="user" title="Identity">
            <div className="pf-grid">
              <Field label="Full name"><input className="input" value={p.fullName ?? ''} onChange={(e) => set({ fullName: e.target.value })} /></Field>
              <Field label="First name"><input className="input" value={p.firstName ?? ''} onChange={(e) => set({ firstName: e.target.value })} /></Field>
              <Field label="Last name"><input className="input" value={p.lastName ?? ''} onChange={(e) => set({ lastName: e.target.value })} /></Field>
              <Field label="Email"><input className="input" value={p.email ?? ''} onChange={(e) => set({ email: e.target.value })} /></Field>
              <Field label="Phone"><input className="input" value={p.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} /></Field>
              <Field label="Headline" hint="one line, shown on every application"
                action={sugBtn('headline', p.headline ?? '', (v) => set({ headline: v }))}>
                <input className="input" placeholder="Backend Engineer · Java, Spring Boot" value={p.headline ?? ''} onChange={(e) => set({ headline: e.target.value })} />
              </Field>
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

          <Section ico="compass" title="Current address">
            <div className="pf-grid">
              <Field label="Current location (short)"><input className="input" value={p.location ?? ''} onChange={(e) => set({ location: e.target.value })} placeholder="Bengaluru" /></Field>
              <Field label="City"><input className="input" value={p.city ?? ''} onChange={(e) => set({ city: e.target.value })} placeholder="Bengaluru" /></Field>
              <Field label="State / Province"><input className="input" value={p.state ?? ''} onChange={(e) => set({ state: e.target.value })} placeholder="Karnataka" /></Field>
              <Field label="Country"><input className="input" list="nationality-list" value={p.country ?? ''} onChange={(e) => set({ country: e.target.value })} placeholder="India" /></Field>
              <Field label="Postal / PIN code"><input className="input" inputMode="numeric" value={p.postalCode ?? ''} onChange={(e) => set({ postalCode: e.target.value })} placeholder="560001" /></Field>
              <Field label="Street address" full><input className="input" value={p.address ?? ''} onChange={(e) => set({ address: e.target.value })} placeholder="Flat / street / area" /></Field>
            </div>
          </Section>

          <Section ico="compass" title="Permanent / alternate address" sub="used when a form asks for a second address">
            <div className="pf-grid">
              <Field label="Location (short)"><input className="input" value={p.location2 ?? ''} onChange={(e) => set({ location2: e.target.value })} placeholder="home town" /></Field>
              <Field label="City"><input className="input" value={p.city2 ?? ''} onChange={(e) => set({ city2: e.target.value })} /></Field>
              <Field label="State / Province"><input className="input" value={p.state2 ?? ''} onChange={(e) => set({ state2: e.target.value })} /></Field>
              <Field label="Country"><input className="input" value={p.country2 ?? ''} onChange={(e) => set({ country2: e.target.value })} /></Field>
              <Field label="Postal / PIN code"><input className="input" value={p.postalCode2 ?? ''} onChange={(e) => set({ postalCode2: e.target.value })} /></Field>
              <Field label="Street address" full><input className="input" value={p.address2 ?? ''} onChange={(e) => set({ address2: e.target.value })} /></Field>
            </div>
          </Section>

          <Section ico="link" title="Links">
            <div className="pf-grid">
              <Field label="GitHub"><input className="input" value={p.links?.github ?? ''} onChange={(e) => setLink('github', e.target.value)} /></Field>
              <Field label="LinkedIn"><input className="input" value={p.links?.linkedin ?? ''} onChange={(e) => setLink('linkedin', e.target.value)} /></Field>
              <Field label="Portfolio"><input className="input" value={p.links?.portfolio ?? ''} onChange={(e) => setLink('portfolio', e.target.value)} /></Field>
              <Field label="LeetCode / DSA profile"><input className="input" placeholder="https://leetcode.com/username/" value={p.links?.leetcode ?? ''} onChange={(e) => setLink('leetcode', e.target.value)} /></Field>
            </div>
          </Section>
        </div>
      )}

      {tab === 'professional' && (
        <div>
          <Section ico="clipboard" title="Current role & compensation">
            <div className="pf-grid">
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

          <Section ico="check" title="Work eligibility & preferences">
            <div className="pf-grid">
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

          <Section ico="bolt" title="Skills" sub="type to search, Enter to add, × to remove">
            <TagInput value={p.skills ?? []} onChange={(v) => set({ skills: v })} suggestions={SKILL_SUGGESTIONS} placeholder="Start typing a skill — e.g. Java, React, Docker…" />
          </Section>

          <Section ico="chart" title="Coding profiles & scores" sub="asked on most Indian tech application forms — used by autofill">
            <div className="pf-grid">
              <Field label="LeetCode profile URL"><input className="input" type="url" placeholder="https://leetcode.com/u/…" value={p.leetcodeUrl ?? ''} onChange={(e) => set({ leetcodeUrl: e.target.value })} /></Field>
              <Field label="LeetCode score / rating"><input className="input" placeholder="1417" value={p.leetcodeScore ?? ''} onChange={(e) => set({ leetcodeScore: e.target.value })} /></Field>
              <Field label="GitHub profile URL"><input className="input" type="url" placeholder="https://github.com/…" value={p.links?.github ?? ''} onChange={(e) => set({ links: { ...(p.links ?? {}), github: e.target.value } })} /></Field>
              <Field label="CodeChef profile URL"><input className="input" type="url" placeholder="https://www.codechef.com/users/…" value={p.codechefUrl ?? ''} onChange={(e) => set({ codechefUrl: e.target.value })} /></Field>
              <Field label="CodeChef score / rating"><input className="input" placeholder="1533" value={p.codechefScore ?? ''} onChange={(e) => set({ codechefScore: e.target.value })} /></Field>
              <span />
              <Field label="Codeforces profile URL"><input className="input" type="url" placeholder="https://codeforces.com/profile/…" value={p.codeforcesUrl ?? ''} onChange={(e) => set({ codeforcesUrl: e.target.value })} /></Field>
              <Field label="Codeforces score / rating"><input className="input" placeholder="643" value={p.codeforcesScore ?? ''} onChange={(e) => set({ codeforcesScore: e.target.value })} /></Field>
            </div>
          </Section>

          <Section ico="gear" title="Work setup" sub="shift willingness + machine details — common screening questions">
            <div className="pf-grid">
              <Field label="Open to working in shifts?">
                <select className="select" value={p.openToShifts ?? ''} onChange={(e) => set({ openToShifts: e.target.value })}>
                  <option value="">Select…</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                  <option value="depends">Depends on the shift/allowance</option>
                </select>
              </Field>
              <Field label="Laptop / PC configuration">
                <input className="input" placeholder="e.g. RTX 3050, 16 GB RAM, 512 GB SSD, Intel i5 12th gen"
                  value={p.laptopConfig ?? ''} onChange={(e) => set({ laptopConfig: e.target.value })} />
              </Field>
            </div>
          </Section>

          <RepeatableList<ExperienceItem>
            ico="trophy" title="Work experience"
            items={p.experience ?? []}
            onChange={(items) => set({ experience: items })}
            empty={{ company: '', title: '', employmentType: '', location: '', start: '', end: '', current: false, description: '' }}
            render={(item, upd) => (
              <>
                <div className="pf-grid">
                  <Field label="Company"><input className="input" value={item.company ?? ''} onChange={(e) => upd({ company: e.target.value })} /></Field>
                  <Field label="Title / role"><input className="input" value={item.title ?? ''} onChange={(e) => upd({ title: e.target.value })} /></Field>
                  <Field label="Employment type">
                    <select className="select" value={item.employmentType ?? ''} onChange={(e) => upd({ employmentType: e.target.value })}>
                      <option value="">Select…</option>
                      {['Full-time', 'Part-time', 'Internship', 'Contract', 'Freelance', 'Apprenticeship'].map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                  <Field label="Location"><input className="input" placeholder="City · Remote / Hybrid / On-site" value={item.location ?? ''} onChange={(e) => upd({ location: e.target.value })} /></Field>
                  <Field label="Start"><input className="input" type="month" value={item.start ?? ''} onChange={(e) => upd({ start: e.target.value })} /></Field>
                  <Field label="End"><input className="input" type="month" value={item.end ?? ''} disabled={item.current} onChange={(e) => upd({ end: e.target.value })} /></Field>
                </div>
                <label className="check-row"><input type="checkbox" checked={!!item.current} onChange={(e) => upd({ current: e.target.checked, end: e.target.checked ? '' : item.end })} /> I currently work here</label>
                <Field label="Description — what you did & impact" full><textarea className="input" rows={3} value={item.description ?? ''} onChange={(e) => upd({ description: e.target.value })} /></Field>
              </>
            )}
          />

          <RepeatableList<CertificationItem>
            ico="clipboard" title="Certifications"
            sub="drop the file itself in Resume → Document vault"
            items={p.certifications ?? []}
            onChange={(items) => set({ certifications: items })}
            empty={{ name: '', issuer: '', link: '', credentialId: '', issued: '', expiry: '' }}
            render={(item, upd) => (
              <>
                <div className="pf-grid">
                  <Field label="Name"><input className="input" value={item.name ?? ''} onChange={(e) => upd({ name: e.target.value })} /></Field>
                  <Field label="Issuer"><input className="input" value={item.issuer ?? ''} onChange={(e) => upd({ issuer: e.target.value })} /></Field>
                  <Field label="Credential ID / no."><input className="input" placeholder="ABC-1234" value={item.credentialId ?? ''} onChange={(e) => upd({ credentialId: e.target.value })} /></Field>
                  <Field label="Issued"><input className="input" type="month" value={item.issued ?? ''} onChange={(e) => upd({ issued: e.target.value })} /></Field>
                </div>
                <Field label="Credential link" full><input className="input" placeholder="https://credential.url/…" value={item.link ?? ''} onChange={(e) => upd({ link: e.target.value })} /></Field>
              </>
            )}
          />

          <Section ico="pen" title="Summary & cover-letter notes" sub="used by the LLM cover-letter generator">
            <label className="pf-f full">
              <span className="pf-f-l">
                Professional summary
                <span className="pf-f-hint">2–4 sentences — feeds cover letters</span>
                {sugBtn('professional summary', p.summary ?? '', (v) => set({ summary: v }))}
              </span>
              <textarea className="input" rows={4} value={p.summary ?? ''} onChange={(e) => set({ summary: e.target.value })} />
            </label>
            <Field label="Cover-letter style/notes (optional)" full><textarea className="input" rows={3} value={p.coverLetterTemplate ?? ''} onChange={(e) => set({ coverLetterTemplate: e.target.value })} placeholder="Tone, things to emphasize, custom intro…" /></Field>
          </Section>
        </div>
      )}

      {tab === 'education' && (
        <div style={{ maxWidth: 820 }}>
          <RepeatableList<EducationItem>
            ico="file" title="Education"
            sub="school, degree, field, dates and score — used for eligibility filters & autofill"
            items={p.education ?? []}
            onChange={(items) => set({ education: items })}
            empty={{ school: '', degree: '', field: '', location: '', startYear: '', endYear: '', gradeType: 'CGPA', grade: '', institutionType: '', specialization: '', current: false }}
            render={(item, upd) => (
              <>
                <div className="pf-grid">
                  <Field label="School / University"><input className="input" value={item.school ?? ''} onChange={(e) => upd({ school: e.target.value })} /></Field>
                  <Field label="Institution type">
                    <select className="select" value={item.institutionType ?? ''} onChange={(e) => upd({ institutionType: e.target.value })}>
                      <option value="">Select…</option>
                      {['University', 'College', 'Junior College', 'School'].map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                  <Field label="Degree"><input className="input" placeholder="B.Tech, 12th (Intermediate), 10th…" value={item.degree ?? ''} onChange={(e) => upd({ degree: e.target.value })} /></Field>
                  <Field label="Field of study / stream"><input className="input" placeholder="Computer Science, MPC…" value={item.field ?? ''} onChange={(e) => upd({ field: e.target.value })} /></Field>
                  <Field label="Specialization (optional)"><input className="input" placeholder="DevOps, AI/ML…" value={item.specialization ?? ''} onChange={(e) => upd({ specialization: e.target.value })} /></Field>
                  <Field label="Location"><input className="input" placeholder="City, Country" value={item.location ?? ''} onChange={(e) => upd({ location: e.target.value })} /></Field>
                </div>
                <div className="pf-grid">
                  <Field label="Start year"><input className="input" type="number" placeholder="2021" value={item.startYear ?? ''} onChange={(e) => upd({ startYear: e.target.value })} /></Field>
                  <Field label="End year (or expected)"><input className="input" type="number" placeholder="2025" value={item.endYear ?? item.year ?? ''} onChange={(e) => upd({ endYear: e.target.value })} /></Field>
                  <Field label="Score">
                    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      <select className="select" style={{ maxWidth: 110 }} value={item.gradeType ?? 'CGPA'} onChange={(e) => upd({ gradeType: e.target.value })}>
                        {['CGPA', 'Percentage', 'GPA', 'Grade'].map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                      <input className="input" style={{ flex: 1 }} placeholder={item.gradeType === 'Percentage' ? '87.5%' : '9.1'} value={item.grade ?? ''} onChange={(e) => upd({ grade: e.target.value })} />
                    </div>
                  </Field>
                </div>
                <label className="check-row"><input type="checkbox" checked={!!item.current} onChange={(e) => upd({ current: e.target.checked })} /> I currently study here</label>
              </>
            )}
          />
          <Marksheets />
        </div>
      )}

      {tab === 'autofill' && (
        <div style={{ maxWidth: 760 }}>
          <Section ico="bolt" title="Custom autofill answers" sub="label keyword → answer; the extension matches these on any form">
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
        <div>
          <Section ico="file" title="Resume" sub="attached to email-apply jobs">
            <div className="row">
              <span className="muted meta-item">{p.resumeFilename ? <><Icon name="file" size={13} /> {p.resumeFilename}</> : 'No resume uploaded'}</span>
              <label className="btn btn-sm">Upload only
                <input type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }} onChange={(e) => onResume(e.target.files?.[0])} />
              </label>
            </div>
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 14 }}>
              <div className="meta-item" style={{ fontWeight: 600, marginBottom: 6 }}><Icon name="sparkles" size={14} /> Smart auto-fill</div>
              <div className="faint" style={{ fontSize: 12, marginBottom: 10 }}>
                Upload a PDF/DOCX resume and AI extracts your name, contact, skills, experience &
                education — then fills and saves the profile. You review and tweak.
              </div>
              <label className="btn btn-primary btn-sm">
                {analyzing ? <span className="spinner" /> : <Icon name="bolt" size={13} />} Analyze resume & auto-fill
                <input type="file" accept=".pdf,.docx" style={{ display: 'none' }} disabled={analyzing} onChange={(e) => onAnalyze(e.target.files?.[0])} />
              </label>
            </div>
          </Section>
          <DocumentsVault />
        </div>
      )}

      {/* Long form → the primary action follows you instead of hiding at the top. */}
      <div className="pf-save">
        <span className="pf-save-t">
          {missing.length === 0
            ? 'Profile complete — everything the automation needs.'
            : `${missing.length} field${missing.length === 1 ? '' : 's'} still empty: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`}
        </span>
        <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={save} disabled={saving}>
          {saving ? <span className="spinner" /> : <Icon name="check" size={14} />} Save profile
        </button>
      </div>
    </div>
  );
}

const DOC_TYPES = ['certificate', 'transcript', 'id-proof', 'offer-letter', 'experience-letter', 'cover-letter',
  '10th-marksheet', '12th-marksheet', 'graduation-marksheet', 'other'];

/** Fixed, labelled upload slots for the marksheets Indian forms require — stored in the
 *  encrypted document vault (AES at rest; download asks for your password). */
function Marksheets() {
  const toast = useToast();
  const [docs, setDocs] = useState<DocItem[] | null>(null);
  const [busy, setBusy] = useState('');
  const load = () => api.docList().then(setDocs).catch(() => setDocs([]));
  useEffect(() => { load(); }, []);

  const SLOTS = [
    { type: '10th-marksheet', label: '10th (SSC) marksheet' },
    { type: '12th-marksheet', label: '12th / Intermediate marksheet' },
    { type: 'graduation-marksheet', label: 'Latest college marksheet (graduation)' },
  ];

  const upload = async (type: string, file?: File | null) => {
    if (!file) return;
    setBusy(type);
    try { await api.docUpload(file, file.name, type); toast('Uploaded & encrypted ✓', 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(''); }
  };

  return (
    <Section ico="shield" title="Marksheets" sub="encrypted in your document vault · PDF or image">
      <div style={{ display: 'grid', gap: 10 }}>
        {SLOTS.map((s) => {
          const doc = (docs ?? []).find((d) => d.type === s.type);
          return (
            <div key={s.type} className="repeat-row" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 0 }}>
              <span className="flow-ico"><Icon name="file" size={16} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 650, fontSize: 13.5 }}>{s.label}</div>
                {doc
                  ? <div className="t-green meta-item" style={{ fontSize: 12.5 }}><Icon name="check" size={12} /> {doc.name}</div>
                  : <div className="faint" style={{ fontSize: 12.5 }}>Not uploaded yet</div>}
              </div>
              <label className={`btn btn-sm ${doc ? '' : 'btn-primary'}`}>
                {busy === s.type ? <span className="spinner" /> : <Icon name="download" size={13} style={{ transform: 'rotate(180deg)' }} />}
                {doc ? 'Replace' : 'Upload'}
                <input type="file" accept=".pdf,image/*" style={{ display: 'none' }} disabled={busy === s.type}
                  onChange={(e) => { upload(s.type, e.target.files?.[0]); e.target.value = ''; }} />
              </label>
            </div>
          );
        })}
      </div>
      <div className="faint" style={{ fontSize: 12, marginTop: 10 }}>
        Files live in the Document vault (Resume tab) — encrypted at rest, download requires your password.
      </div>
    </Section>
  );
}

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
    <Section ico="shield" title="Document vault" sub="encrypted at rest · download asks for your password">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select className="select" value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 200 }}>
          {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="btn btn-primary btn-sm">
          {busy ? <span className="spinner" /> : <Icon name="download" size={13} style={{ transform: 'rotate(180deg)' }} />} Upload document(s)
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
        {busy ? <span className="spinner" /> : <>Drag &amp; drop files here — stored as “<b>{type}</b>”</>}
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
                  <button className="btn btn-sm" onClick={() => { setPwFor(d); setPw(''); }}><Icon name="download" size={13} /> Download</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => remove(d)} style={{ color: 'var(--danger,#ef4444)' }}><Icon name="trash" size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        )}

      {pwFor && (
        <Modal title="Confirm your password to download" onClose={() => setPwFor(null)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setPwFor(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={doDownload} disabled={busy || !pw}>{busy ? <span className="spinner" /> : <Icon name="download" size={14} />} Download</button>
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
      <div className="section-title"><span className="si"><Icon name={ico} size={15} /></span>{title}{sub && <span className="section-sub">{sub}</span>}</div>
      {children}
    </div>
  );
}
/**
 * One labelled control. Label sits ABOVE the input (never placeholder-only), with room for a
 * hint and an optional action (the AI "Suggest" chip) on the right of the label row.
 */
function Field({ label, hint, children, full, action }: {
  label: string; hint?: string; children: React.ReactNode; full?: boolean; action?: React.ReactNode;
}) {
  return (
    <label className={`pf-f ${full ? 'full' : ''}`}>
      <span className="pf-f-l">
        {label}
        {hint && <span className="pf-f-hint">{hint}</span>}
        {action}
      </span>
      {children}
    </label>
  );
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
  ico, title, sub, items, onChange, render, empty,
}: {
  ico: string; title: string; sub?: string; items: T[]; onChange: (items: T[]) => void;
  render: (item: T, upd: (patch: Partial<T>) => void) => React.ReactNode; empty: T;
}) {
  const upd = (i: number, patch: Partial<T>) => onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  return (
    <Section ico={ico} title={title} sub={sub}>
      {items.length === 0 && <div className="faint" style={{ marginBottom: 10 }}>None yet — click Add to create one.</div>}
      {items.map((item, i) => (
        <div className="repeat-row" key={i}>
          <div className="rh"><span className="muted" style={{ fontSize: 12, fontWeight: 700 }}>#{i + 1}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => remove(i)}><Icon name="trash" size={13} /> Remove</button></div>
          {render(item, (patch) => upd(i, patch))}
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => onChange([...items, { ...empty }])}><Icon name="plus" size={13} /> Add {title.toLowerCase()}</button>
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
          <button className="btn btn-ghost btn-sm" onClick={() => remove(k)}><Icon name="x" size={13} /></button>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => onChange({ ...map, [`question ${entries.length + 1}`]: '' })}>+ Add answer</button>
    </>
  );
}
