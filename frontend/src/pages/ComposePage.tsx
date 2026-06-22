import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../lib/ui';
import { ModelSwitcher } from '../components/ModelSwitcher';

export function ComposePage() {
  const toast = useToast();
  const [role, setRole] = useState('');
  const [company, setCompany] = useState('');
  const [details, setDetails] = useState('');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [coverLetter, setCoverLetter] = useState('');
  const [coldEmail, setColdEmail] = useState('');
  const [attachResume, setAttachResume] = useState(true);
  const [mode, setMode] = useState<'both' | 'email' | 'cover'>('both');
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [ai, setAi] = useState<{ enabled: boolean; provider: string; remainingToday: number } | null>(null);

  useEffect(() => { api.aiStatus().then(setAi).catch(() => {}); }, []);

  const generate = async () => {
    if (!role && !details) { toast('Add a role or job details first', 'error'); return; }
    setGenerating(true);
    try {
      const r = await api.composeGenerate(role, company, details);
      setCoverLetter(r.coverLetter || '');
      setColdEmail(r.coldEmail || '');
      if (r.subject) setSubject(r.subject);
      toast('Generated subject, cold email & cover letter — review before sending', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setGenerating(false); }
  };

  const copy = async (text: string, label: string) => {
    if (!text) { toast('Nothing to copy yet', 'info'); return; }
    try { await navigator.clipboard.writeText(text); toast(`${label} copied`, 'success'); }
    catch { toast('Copy failed', 'error'); }
  };

  const send = async () => {
    if (!to) { toast('Recipient email required', 'error'); return; }
    if (!coldEmail && !coverLetter) { toast('Generate the content first', 'error'); return; }
    // Send mode decides which parts go out.
    const sendEmail = mode === 'both' || mode === 'email' ? coldEmail : '';
    const sendCover = mode === 'both' || mode === 'cover' ? coverLetter : '';
    if (!sendEmail && !sendCover) { toast('Nothing to send for this mode', 'error'); return; }
    setSending(true);
    try {
      const r = await api.composeSend({ to, subject, coldEmail: sendEmail, coverLetter: sendCover, attachResume });
      toast(`Sent to ${r.sentTo}${r.resumeAttached ? ' (resume attached)' : ''}`, 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setSending(false); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Compose & send</h1>
          <div className="page-sub">Generate a cover letter + cold email from any job, review, and send with your resume</div>
        </div>
        <ModelSwitcher />
      </div>

      <div className="grid2" style={{ alignItems: 'start' }}>
        <div className="card card-pad section">
          <div className="section-title"><span className="si">📥</span>Job details</div>
          <div className="grid2">
            <label className="field">Role / title<input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Backend Engineer" /></label>
            <label className="field">Company<input className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme" /></label>
          </div>
          <label className="field" style={{ marginTop: 12 }}>Paste the job description / details
            <textarea className="input" rows={8} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Responsibilities, requirements, anything you want the letter to address…" />
          </label>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={generate} disabled={generating || (ai !== null && !ai.enabled)}>
            {generating ? <span className="spinner" /> : '✨'} Generate cover letter + cold email
          </button>
          {ai !== null && !ai.enabled && <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Set an AI provider + key in <code>.env</code> to enable generation.</div>}
        </div>

        <div className="card card-pad section">
          <div className="section-title"><span className="si">📤</span>Send</div>
          <div className="grid2">
            <label className="field">Recipient email<input className="input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="recruiter@company.com" /></label>
            <label className="field">Subject<input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
          </div>
          <div className="field" style={{ marginTop: 10 }}>What to send
            <div className="tabs" style={{ marginTop: 6 }}>
              {([['both', 'Email + cover letter'], ['email', 'Email only'], ['cover', 'Cover letter only']] as const).map(([k, label]) => (
                <div key={k} className={`tab ${mode === k ? 'active' : ''}`} onClick={() => setMode(k)}>{label}</div>
              ))}
            </div>
          </div>
          <label className="row" style={{ marginTop: 10, gap: 8 }}>
            <input type="checkbox" checked={attachResume} onChange={(e) => setAttachResume(e.target.checked)} /> Attach my resume
          </label>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={send} disabled={sending}>
            {sending ? <span className="spinner" /> : '✉'} Send {mode === 'email' ? 'email' : mode === 'cover' ? 'cover letter' : 'both'} to {to || 'recipient'}
          </button>
          <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Sends from your configured Gmail. Counts against the daily mail limit.</div>
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 16, alignItems: 'start' }}>
        <div className="panel">
          <div className="panel-head">✉ Cold email <button className="btn copy-btn" onClick={() => copy(coldEmail, 'Cold email')}>Copy</button></div>
          <textarea rows={11} value={coldEmail} onChange={(e) => setColdEmail(e.target.value)} placeholder="Generated cold email appears here…" />
        </div>
        <div className="panel">
          <div className="panel-head">📄 Cover letter <button className="btn copy-btn" onClick={() => copy(coverLetter, 'Cover letter')}>Copy</button></div>
          <textarea rows={11} value={coverLetter} onChange={(e) => setCoverLetter(e.target.value)} placeholder="Generated cover letter appears here…" />
        </div>
      </div>
    </>
  );
}
