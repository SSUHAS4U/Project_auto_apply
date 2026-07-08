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
  const [emailTpl, setEmailTpl] = useState('');
  const [coverTpl, setCoverTpl] = useState('');
  const [savingTpl, setSavingTpl] = useState(false);
  const [refineText, setRefineText] = useState('');
  const [refining, setRefining] = useState(false);

  useEffect(() => { api.aiStatus().then(setAi).catch(() => {}); }, []);
  useEffect(() => {
    api.profile().then((p) => { setEmailTpl(p.emailTemplate ?? ''); setCoverTpl(p.coverLetterTemplate ?? ''); }).catch(() => {});
  }, []);

  const saveTemplates = async () => {
    setSavingTpl(true);
    try {
      const p = await api.profile();
      await api.saveProfile({ ...p, emailTemplate: emailTpl, coverLetterTemplate: coverTpl });
      toast('Templates saved — used as the base for generation', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setSavingTpl(false); }
  };

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

  const refine = async () => {
    const instruction = refineText.trim();
    if (!instruction) return;
    setRefining(true);
    try {
      const r = await api.composeRefine({ coldEmail, coverLetter, instruction });
      setColdEmail(r.coldEmail || '');
      setCoverLetter(r.coverLetter || '');
      setRefineText('');
      toast('Updated — review the changes', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setRefining(false); }
  };

  const downloadText = (text: string, filename: string) => {
    if (!text.trim()) { toast('Nothing to download yet', 'error'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  const downloadCoverPdf = async () => {
    if (!coverLetter) { toast('Generate the cover letter first', 'info'); return; }
    try {
      const blob = await api.composeCoverPdf(coverLetter);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `CoverLetter_${(company || 'JobPilot').replace(/[^a-z0-9]/gi, '')}.pdf`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { toast((e as Error).message, 'error'); }
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
      const att = [r.coverLetterAttached && 'cover letter', r.resumeAttached && 'resume'].filter(Boolean).join(' + ');
      toast(`Sent to ${r.sentTo}${att ? ` (${att} attached as PDF)` : ''}`, 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setSending(false); }
  };

  const hasContent = !!(coldEmail || coverLetter);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Compose &amp; send</h1>
          <div className="page-sub">Generate a tailored cold email + cover letter from any job, review, then send with your resume.</div>
        </div>
        <ModelSwitcher />
      </div>

      <div style={{ maxWidth: 980, margin: '0 auto', marginBottom: 18 }}>
        <details className="card card-pad">
          <summary style={{ cursor: 'pointer', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="si">📋</span> My templates <span className="faint" style={{ fontWeight: 400, fontSize: 12.5 }}>— the AI rewrites these for each role</span>
          </summary>
          <div className="grid2" style={{ marginTop: 14, alignItems: 'start' }}>
            <label className="field">Email template
              <textarea className="input" rows={8} value={emailTpl} onChange={(e) => setEmailTpl(e.target.value)} placeholder="Hi [Hiring Team], I came across the [Role] opening at [Company]…" />
            </label>
            <label className="field">Cover-letter template
              <textarea className="input" rows={8} value={coverTpl} onChange={(e) => setCoverTpl(e.target.value)} placeholder="Dear Hiring Manager, I am writing to express my interest in the [Role] role at [Company]…" />
            </label>
          </div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={saveTemplates} disabled={savingTpl}>
            {savingTpl ? <span className="spinner" /> : '💾'} Save templates
          </button>
        </details>
      </div>

      <div style={{ maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Step 1 — Job details */}
        <div className="card card-pad">
          <div className="step-head">
            <span className="step-num">1</span>
            <div><div className="step-title">Job details</div><div className="step-sub">What you're applying to — the more detail, the more tailored the writing.</div></div>
          </div>
          <div className="grid2">
            <label className="field">Role / title<input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Backend Engineer" /></label>
            <label className="field">Company<input className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme" /></label>
          </div>
          <label className="field" style={{ marginTop: 14 }}>Job description / details
            <textarea className="input" rows={7} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Paste responsibilities, requirements, anything you want the letter to address…" />
          </label>
          <div className="row" style={{ marginTop: 14, justifyContent: 'space-between' }}>
            <button className="btn btn-primary" onClick={generate} disabled={generating || (ai !== null && !ai.enabled)}>
              {generating ? <span className="spinner" /> : '✨'} {hasContent ? 'Regenerate' : 'Generate'}
            </button>
            {ai !== null && !ai.enabled && <span className="faint" style={{ fontSize: 12 }}>Set an AI provider + key in Settings to enable.</span>}
          </div>
        </div>

        {/* Step 2 — Review & edit */}
        <div className="card card-pad">
          <div className="step-head">
            <span className="step-num">2</span>
            <div><div className="step-title">Review &amp; edit</div><div className="step-sub">Tweak anything before it goes out — these are editable.</div></div>
          </div>
          {!hasContent ? (
            <div className="empty" style={{ padding: '28px 20px' }}>
              <div className="big">📝</div>
              Your cold email and cover letter will appear here after you generate.
            </div>
          ) : (
            <>
              <div className="grid2" style={{ alignItems: 'start' }}>
                <div className="panel">
                  <div className="panel-head">✉ Cold email
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button className="btn copy-btn" onClick={() => downloadText(coldEmail, `ColdEmail_${(company || 'JobPilot').replace(/[^a-z0-9]/gi, '')}.txt`)}>⬇ Download</button>
                      <button className="btn copy-btn" onClick={() => copy(coldEmail, 'Cold email')}>Copy</button>
                    </span>
                  </div>
                  <textarea rows={12} value={coldEmail} onChange={(e) => setColdEmail(e.target.value)} placeholder="Generated cold email appears here…" />
                </div>
                <div className="panel">
                  <div className="panel-head">📄 Cover letter
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button className="btn copy-btn" onClick={downloadCoverPdf}>⬇ PDF</button>
                      <button className="btn copy-btn" onClick={() => downloadText(coverLetter, `CoverLetter_${(company || 'JobPilot').replace(/[^a-z0-9]/gi, '')}.txt`)}>⬇ .txt</button>
                      <button className="btn copy-btn" onClick={() => copy(coverLetter, 'Cover letter')}>Copy</button>
                    </span>
                  </div>
                  <textarea rows={12} value={coverLetter} onChange={(e) => setCoverLetter(e.target.value)} placeholder="Generated cover letter appears here…" />
                </div>
              </div>
              {/* Refine chat — tweak specific words or the whole thing in natural language */}
              <div className="row" style={{ marginTop: 14, gap: 8 }}>
                <input className="input" style={{ flex: 1 }} value={refineText}
                  onChange={(e) => setRefineText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') refine(); }}
                  placeholder='Tell the AI how to tweak it — e.g. "make the email shorter", "mention my React projects", "more formal tone"' />
                <button className="btn btn-primary" onClick={refine} disabled={refining}>
                  {refining ? <span className="spinner" /> : '✨'} Refine
                </button>
              </div>
            </>
          )}
        </div>

        {/* Step 3 — Send */}
        <div className="card card-pad">
          <div className="step-head">
            <span className="step-num">3</span>
            <div><div className="step-title">Send</div><div className="step-sub">Goes out via your configured mail. A copy is BCC'd to you.</div></div>
          </div>
          <div className="grid2">
            <label className="field">Recipient email<input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="recruiter@company.com" /></label>
            <label className="field">Subject<input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Application for…" /></label>
          </div>
          <div className="field" style={{ marginTop: 14 }}>What to send
            <div className="seg" style={{ marginTop: 6 }}>
              {([['both', 'Email + cover letter'], ['email', 'Email only'], ['cover', 'Cover letter only']] as const).map(([k, label]) => (
                <button key={k} type="button" className={`seg-btn ${mode === k ? 'active' : ''}`} onClick={() => setMode(k)}>{label}</button>
              ))}
            </div>
          </div>
          <label className="row" style={{ marginTop: 14, gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={attachResume} onChange={(e) => setAttachResume(e.target.checked)} /> Attach my resume
          </label>
          <button className="btn btn-primary" style={{ marginTop: 16, width: '100%', justifyContent: 'center' }} onClick={send} disabled={sending || !hasContent}>
            {sending ? <span className="spinner" /> : '✉'} Send {mode === 'email' ? 'email' : mode === 'cover' ? 'cover letter' : 'email + cover letter'} to {to || 'recipient'}
          </button>
        </div>
      </div>
    </>
  );
}
