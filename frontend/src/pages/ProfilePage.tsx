import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Profile } from '../types';
import { useToast } from '../lib/ui';

export function ProfilePage() {
  const toast = useToast();
  const [p, setP] = useState<Profile | null>(null);
  const [skillsText, setSkillsText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.profile().then((prof) => {
      setP(prof);
      setSkillsText((prof.skills ?? []).join(', '));
    }).catch((e) => toast(e.message, 'error'));
  }, []); // eslint-disable-line

  if (!p) return <div className="empty"><span className="spinner" /></div>;

  const set = (k: keyof Profile, v: unknown) => setP({ ...p, [k]: v });
  const setLink = (k: string, v: string) => setP({ ...p, links: { ...(p.links ?? {}), [k]: v } });

  const save = async () => {
    setSaving(true);
    try {
      const body: Profile = { ...p, skills: skillsText.split(',').map((s) => s.trim()).filter(Boolean) };
      const saved = await api.saveProfile(body);
      setP(saved);
      toast('Profile saved', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setSaving(false); }
  };

  const onResume = async (file?: File) => {
    if (!file) return;
    try { const r = await api.uploadResume(file); set('resumeFilename', r.filename); toast('Resume uploaded', 'success'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Profile</h1>
          <div className="page-sub">Used for matching, cover letters & extension autofill</div>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? <span className="spinner" /> : '💾'} Save</button>
      </div>

      <div className="card card-pad" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, maxWidth: 820 }}>
        <label className="field">Full name<input className="input" value={p.fullName ?? ''} onChange={(e) => set('fullName', e.target.value)} /></label>
        <label className="field">Email<input className="input" value={p.email ?? ''} onChange={(e) => set('email', e.target.value)} /></label>
        <label className="field">Phone<input className="input" value={p.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></label>
        <label className="field">Location<input className="input" value={p.location ?? ''} onChange={(e) => set('location', e.target.value)} /></label>
        <label className="field">Seniority
          <select className="select" value={p.seniority ?? ''} onChange={(e) => set('seniority', e.target.value)}>
            <option value="">—</option><option value="entry">entry</option><option value="mid">mid</option><option value="senior">senior</option>
          </select>
        </label>
        <label className="field">GitHub<input className="input" value={p.links?.github ?? ''} onChange={(e) => setLink('github', e.target.value)} /></label>
        <label className="field">LinkedIn<input className="input" value={p.links?.linkedin ?? ''} onChange={(e) => setLink('linkedin', e.target.value)} /></label>
        <label className="field">Portfolio<input className="input" value={p.links?.portfolio ?? ''} onChange={(e) => setLink('portfolio', e.target.value)} /></label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>Skills (comma-separated)
          <input className="input" value={skillsText} onChange={(e) => setSkillsText(e.target.value)} placeholder="java, spring, postgres, react" />
        </label>
        <div className="skill-row" style={{ gridColumn: '1 / -1' }}>
          {skillsText.split(',').map((s) => s.trim()).filter(Boolean).map((s) => <span key={s} className="chip">{s}</span>)}
        </div>
      </div>

      <div className="card card-pad" style={{ marginTop: 16, maxWidth: 820 }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Resume</div>
        <div className="row">
          <span className="muted">{p.resumeFilename ? `📄 ${p.resumeFilename}` : 'No resume uploaded'}</span>
          <label className="btn btn-sm">Upload
            <input type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }} onChange={(e) => onResume(e.target.files?.[0])} />
          </label>
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Attached automatically to email-apply jobs.</div>
      </div>
    </>
  );
}
