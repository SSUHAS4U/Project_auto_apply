import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ComposeExtract, type ResumeDoc, type SentMessage } from '../api/client';
import { useToast } from '../lib/ui';
import { Icon } from '../components/Icon';
import { NO_RESUME, PROFILE_FILE, ResumeChooser } from '../components/ResumeChooser';
import { ago, mergeDetected, previousContacts, suggestResume, type Fillable } from '../lib/outreach';

/** Where the subject came from — a subject the POST asked for is never replaced by the AI's. */
type SubjectSource = '' | 'post' | 'ai' | 'user';

export function ComposePage() {
  const toast = useToast();
  const [role, setRole] = useState('');
  const [company, setCompany] = useState('');
  const [details, setDetails] = useState('');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [subjectSource, setSubjectSource] = useState<SubjectSource>('');
  const [coverLetter, setCoverLetter] = useState('');
  const [coldEmail, setColdEmail] = useState('');
  const [mode, setMode] = useState<'both' | 'email' | 'cover'>('both');
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [ai, setAi] = useState<{ enabled: boolean; provider: string; remainingToday: number } | null>(null);
  const [emailTpl, setEmailTpl] = useState('');
  const [coverTpl, setCoverTpl] = useState('');
  const [savingTpl, setSavingTpl] = useState(false);
  const [refineText, setRefineText] = useState('');
  const [refining, setRefining] = useState(false);

  // Reading the pasted post.
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<{ found: string[]; info: ComposeExtract } | null>(null);
  // Fields the user typed in — a later paste never overwrites those.
  const typed = useRef<Set<Fillable>>(new Set());
  const touch = (k: Fillable) => { typed.current.add(k); };

  // Résumé to send — always an explicit choice.
  const [resumes, setResumes] = useState<ResumeDoc[] | null>(null);
  const [profileResume, setProfileResume] = useState('');
  const [resumeChoice, setResumeChoice] = useState('');
  const [resumePicked, setResumePicked] = useState(false); // chosen by the user, not suggested

  // WhatsApp.
  const [phone, setPhone] = useState('');
  const [myWhatsapp, setMyWhatsapp] = useState('');
  const [myCountryCode, setMyCountryCode] = useState('91');
  const [waMessage, setWaMessage] = useState('');
  const [waResume, setWaResume] = useState(true);
  const [waCover, setWaCover] = useState(true);
  const [waBusy, setWaBusy] = useState(false);

  const [history, setHistory] = useState<SentMessage[]>([]);

  useEffect(() => { api.aiStatus().then(setAi).catch(() => {}); }, []);
  useEffect(() => {
    api.profile().then((p) => {
      setEmailTpl(p.emailTemplate ?? '');
      setCoverTpl(p.coverLetterTemplate ?? '');
      setProfileResume(p.resumeFilename ?? '');
      setMyWhatsapp(p.whatsappNumber || p.phone || '');
      setMyCountryCode((p.phoneCountryCode || '91').replace(/\D/g, '') || '91');
    }).catch(() => {});
    api.resumeList().then(setResumes).catch(() => setResumes([]));
    api.history().then(setHistory).catch(() => {});
  }, []);

  // ---- résumé choice ----
  const sendable = useMemo(() => (resumes ?? []).filter((r) => r.hasPdf), [resumes]);
  const suggested = useMemo(() => suggestResume(resumes ?? [], role), [resumes, role]);
  // Suggest, never silently decide: a match by role, or the only résumé there is. With several
  // and no match the choice stays empty and Send asks for it.
  useEffect(() => {
    if (resumePicked || resumes === null) return;
    if (suggested) setResumeChoice(suggested.id);
    else if (sendable.length === 1) setResumeChoice(sendable[0].id);
    else if (sendable.length === 0 && profileResume) setResumeChoice(PROFILE_FILE);
    else setResumeChoice('');
  }, [suggested, sendable, profileResume, resumes, resumePicked]);

  const chosenResume = (resumes ?? []).find((r) => r.id === resumeChoice) ?? null;
  const unbuilt = (resumes ?? []).filter((r) => !r.hasPdf).length;
  const resumeHint = !resumeChoice
    ? (sendable.length === 0 && !profileResume
      ? 'No résumé yet — add one in Profile → Résumé, or send without one.'
      : 'Choose one to continue.')
    : !resumePicked && suggested && resumeChoice === suggested.id ? `Picked because its role matches “${role}”.` : '';

  // ---- earlier contact with this company / recipient ----
  const earlier = useMemo(() => previousContacts(history, { company, email: to, phone }), [history, company, to, phone]);

  // ---- read the pasted post ----
  const detect = async (text: string, quiet = false) => {
    if (text.trim().length < 20) { if (!quiet) toast('Paste the job post first', 'info'); return; }
    setDetecting(true);
    try {
      const r = await api.composeExtract(text);
      const changes = mergeDetected(
        { role, company, to, subject, phone },
        typed.current,
        { role: r.role, company: r.company, to: r.email, phone: r.phone, subject: r.subjectRequested ? r.subject : '' },
      );
      if (changes.role !== undefined) setRole(changes.role);
      if (changes.company !== undefined) setCompany(changes.company);
      if (changes.to !== undefined) setTo(changes.to);
      if (changes.phone !== undefined) setPhone(changes.phone);
      if (changes.subject !== undefined) { setSubject(changes.subject); setSubjectSource('post'); }
      const found = [
        r.role && 'role', r.company && 'company', r.email && 'email',
        r.subjectRequested && 'subject', r.phone && 'phone',
      ].filter(Boolean) as string[];
      setDetected({ found, info: r });
    } catch (e) {
      if (!quiet) toast((e as Error).message, 'error');
    } finally { setDetecting(false); }
  };

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
      if (r.whatsapp) setWaMessage(r.whatsapp);
      // The post's own subject and one the user typed both outrank the AI's.
      if (r.subject && subjectSource !== 'post' && !(subjectSource === 'user' && subject.trim())) {
        setSubject(r.subject);
        setSubjectSource('ai');
      }
      toast('Generated — review before sending', 'success');
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

  const refreshHistory = () => api.history().then(setHistory).catch(() => {});

  const send = async () => {
    if (!to) { toast('Recipient email required', 'error'); return; }
    if (!coldEmail && !coverLetter) { toast('Generate the content first', 'error'); return; }
    if (!resumeChoice) { toast('Choose which résumé to send — or "Don\'t attach a résumé"', 'error'); return; }
    const sendEmail = mode === 'both' || mode === 'email' ? coldEmail : '';
    const sendCover = mode === 'both' || mode === 'cover' ? coverLetter : '';
    if (!sendEmail && !sendCover) { toast('Nothing to send for this mode', 'error'); return; }
    setSending(true);
    try {
      const r = await api.composeSend({
        to, subject, coldEmail: sendEmail, coverLetter: sendCover,
        attachResume: resumeChoice !== NO_RESUME,
        resumeId: resumeChoice === NO_RESUME || resumeChoice === PROFILE_FILE ? undefined : resumeChoice,
        company, role,
      });
      const att = [r.coverLetterAttached && 'cover letter', r.resumeAttached && (r.resumeName ? `“${r.resumeName}”` : 'résumé')].filter(Boolean).join(' + ');
      toast(`Sent to ${r.sentTo}${att ? ` with ${att}` : ''}`, 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setSending(false); refreshHistory(); }
  };

  // ---- WhatsApp ----
  const waLinkResume = waResume && !!chosenResume;
  const openWhatsapp = async () => {
    if (!phone.trim()) { toast('Add the recruiter\'s WhatsApp number', 'error'); return; }
    if (!waMessage.trim()) { toast('Write the message first — Generate fills it in', 'error'); return; }
    // Open the tab NOW, inside the click, or the browser blocks it as a pop-up once the request
    // returns. The desktop app has no blank window to open; it opens the final URL externally.
    const win = window.open('', '_blank');
    setWaBusy(true);
    try {
      const r = await api.composeWhatsapp({
        phone, message: waMessage, company, role,
        includeResume: waLinkResume, resumeId: waLinkResume ? chosenResume!.id : undefined,
        coverLetter: waCover && coverLetter ? coverLetter : undefined,
      });
      if (win) win.location.href = r.url;
      else window.open(r.url, '_blank');
      toast(`WhatsApp opened for ${r.phone} — press Send there`, 'success');
    } catch (e) {
      win?.close();
      toast((e as Error).message, 'error');
    } finally { setWaBusy(false); refreshHistory(); }
  };

  /** Send the message to your own number first, to see exactly what the recruiter will get. */
  const previewOnMyPhone = () => {
    const digits = myWhatsapp.replace(/\D/g, '');
    if (digits.length < 8) { toast('Add your WhatsApp number in Profile → Personal', 'error'); return; }
    const own = myWhatsapp.trim().startsWith('+') ? digits : digits.length === 10 ? myCountryCode + digits : digits.replace(/^0/, myCountryCode);
    window.open(`https://wa.me/${own}?text=${encodeURIComponent(waMessage || 'Test from JobPilot')}`, '_blank');
  };

  const hasContent = !!(coldEmail || coverLetter);
  const label = (k: string) => ({ role: 'Role', company: 'Company', email: 'Recipient', subject: 'Subject', phone: 'Phone' } as Record<string, string>)[k] ?? k;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Compose &amp; send</h1>
          <div className="page-sub">Paste a job post — the role, company, recipient and any subject it asks for are filled in. Review, then send by email or WhatsApp.</div>
        </div>
        <div className="page-acts">
          <Link to="/history" className="btn"><Icon name="clock" size={14} /> History</Link>
        </div>
      </div>

      <div style={{ maxWidth: 980, margin: '0 auto', marginBottom: 18 }}>
        <details className="card card-pad">
          <summary style={{ cursor: 'pointer', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="si"><Icon name="clipboard" size={15} /></span> My templates <span className="faint" style={{ fontWeight: 400, fontSize: 12.5 }}>— the AI rewrites these for each role</span>
          </summary>
          <div className="grid2" style={{ marginTop: 14, alignItems: 'start' }}>
            <label className="field">Email template
              <textarea className="input" rows={8} value={emailTpl} onChange={(e) => setEmailTpl(e.target.value)} placeholder="Hi [Hiring Team], I came across the [Role] opening at [Company]…" />
            </label>
            <label className="field">Cover-letter template
              <textarea className="input" rows={8} value={coverTpl} onChange={(e) => setCoverTpl(e.target.value)} placeholder="Dear Hiring Manager, I am writing to express my interest in the [Role] role at [Company]…" />
            </label>
          </div>
          <button className="btn" style={{ marginTop: 12 }} onClick={saveTemplates} disabled={savingTpl}>
            {savingTpl ? <span className="spinner" /> : <Icon name="check" size={14} />} Save templates
          </button>
        </details>
      </div>

      <div style={{ maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Step 1 — Job details */}
        <div className="card card-pad">
          <div className="step-head">
            <span className="step-num">1</span>
            <div><div className="step-title">Job details</div><div className="step-sub">Paste the whole post — contact details and a requested subject are picked up automatically.</div></div>
          </div>
          <label className="field">Job description / details
            <textarea className="input" rows={7} value={details}
              onChange={(e) => setDetails(e.target.value)}
              onPaste={(e) => {
                // Read the textarea AFTER the paste lands, so the whole post is detected — not
                // just the pasted fragment.
                const el = e.currentTarget;
                requestAnimationFrame(() => detect(el.value, true));
              }}
              placeholder="Paste the job post — responsibilities, requirements, and the How to apply part with the email or phone…" />
          </label>
          <div className="cp-detect" aria-live="polite">
            {detecting ? <><span className="spinner" /> Reading the post…</>
              : detected ? (
                detected.found.length > 0 ? (
                  <>
                    <Icon name="check" size={13} />
                    <span>Found in the post:</span>
                    {detected.found.map((k) => <span key={k} className="chip chip-neutral">{label(k)}</span>)}
                    {!detected.found.includes('subject') && <span className="faint">· no subject asked for — one will be written</span>}
                  </>
                ) : <><Icon name="alert" size={13} /> Nothing to fill found in this post — type the details in.</>
              ) : <span className="faint">Paste a post to fill the fields below.</span>}
            <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => detect(details)} disabled={detecting || details.trim().length < 20}>
              <Icon name="refresh" size={13} /> Read again
            </button>
          </div>
          <div className="grid2" style={{ marginTop: 14 }}>
            <label className="field">Role / title<input className="input" value={role} onChange={(e) => { setRole(e.target.value); touch('role'); }} placeholder="Backend Engineer" /></label>
            <label className="field">Company<input className="input" value={company} onChange={(e) => { setCompany(e.target.value); touch('company'); }} placeholder="Acme" /></label>
          </div>
          {earlier.length > 0 && (
            <div className="cp-note cp-note-warn" style={{ marginTop: 14 }}>
              <Icon name="alert" size={15} />
              <div>
                You already contacted {earlier[0].company || earlier[0].recipient} {ago(earlier[0].createdAt)} by {earlier[0].channel === 'EMAIL' ? 'email' : 'WhatsApp'}
                {earlier.length > 1 ? ` (${earlier.length} times in all)` : ''}. <Link to="/history">See History</Link>
              </div>
            </div>
          )}
          <div className="row" style={{ marginTop: 14, justifyContent: 'space-between' }}>
            <button className="btn btn-primary" onClick={generate} disabled={generating || (ai !== null && !ai.enabled)}>
              {generating ? <span className="spinner" /> : <Icon name="sparkles" size={14} />} {hasContent ? 'Regenerate' : 'Generate'}
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
              <div className="big"><Icon name="pen" size={34} /></div>
              Your cold email, cover letter and WhatsApp message will appear here after you generate.
            </div>
          ) : (
            <>
              <div className="grid2" style={{ alignItems: 'start' }}>
                <div className="panel">
                  <div className="panel-head"><span className="meta-item"><Icon name="mail" size={14} /> Cold email</span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button className="btn copy-btn" onClick={() => downloadText(coldEmail, `ColdEmail_${(company || 'JobPilot').replace(/[^a-z0-9]/gi, '')}.txt`)}><Icon name="download" size={12} /> Download</button>
                      <button className="btn copy-btn" onClick={() => copy(coldEmail, 'Cold email')}>Copy</button>
                    </span>
                  </div>
                  <textarea rows={12} value={coldEmail} onChange={(e) => setColdEmail(e.target.value)} placeholder="Generated cold email appears here…" />
                </div>
                <div className="panel">
                  <div className="panel-head"><span className="meta-item"><Icon name="file" size={14} /> Cover letter</span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button className="btn copy-btn" onClick={downloadCoverPdf}><Icon name="download" size={12} /> PDF</button>
                      <button className="btn copy-btn" onClick={() => downloadText(coverLetter, `CoverLetter_${(company || 'JobPilot').replace(/[^a-z0-9]/gi, '')}.txt`)}><Icon name="download" size={12} /> .txt</button>
                      <button className="btn copy-btn" onClick={() => copy(coverLetter, 'Cover letter')}>Copy</button>
                    </span>
                  </div>
                  <textarea rows={12} value={coverLetter} onChange={(e) => setCoverLetter(e.target.value)} placeholder="Generated cover letter appears here…" />
                </div>
              </div>
              <div className="row" style={{ marginTop: 14, gap: 8 }}>
                <input className="input" style={{ flex: 1, minWidth: 0 }} value={refineText}
                  onChange={(e) => setRefineText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') refine(); }}
                  placeholder='Tell the AI how to tweak it — e.g. "make the email shorter", "mention my React projects"' />
                <button className="btn" onClick={refine} disabled={refining}>
                  {refining ? <span className="spinner" /> : <Icon name="sparkles" size={13} />} Refine
                </button>
              </div>
            </>
          )}
        </div>

        {/* Step 3 — Send by email */}
        <div className="card card-pad">
          <div className="step-head">
            <span className="step-num">3</span>
            <div><div className="step-title">Send by email</div><div className="step-sub">Goes out via your configured mail. A copy is BCC'd to you, and it's logged in History.</div></div>
          </div>
          <div className="grid2">
            <label className="field">Recipient email<input className="input" type="email" value={to} onChange={(e) => { setTo(e.target.value); touch('to'); }} placeholder="recruiter@company.com" /></label>
            <label className="field">
              <span className="cp-label">Subject
                {subjectSource === 'post' && <span className="chip chip-neutral" title="The post asks applicants to use this subject">From the post</span>}
              </span>
              <input className="input" value={subject} onChange={(e) => { setSubject(e.target.value); setSubjectSource('user'); touch('subject'); }} placeholder="Application for…" />
            </label>
          </div>
          <div className="cp-group">
            <div className="cp-group-h">
              <span className="cp-group-t" id="cp-resume-t">Résumé to send</span>
              {resumeHint && <span className={`cp-group-hint ${!resumeChoice ? 'cp-need' : ''}`}>{resumeHint}</span>}
              <Link to="/profile" className="cp-group-link">Manage résumés</Link>
            </div>
            {resumes === null
              ? <div className="rc"><div className="rc-skel" /><div className="rc-skel" /></div>
              : <ResumeChooser resumes={sendable} profileFile={profileResume} value={resumeChoice}
                  suggestedId={suggested?.id} onChange={(v) => { setResumeChoice(v); setResumePicked(true); }} />}
            {unbuilt > 0 && (
              <div className="field-hint" style={{ marginTop: 8 }}>
                {unbuilt} résumé{unbuilt === 1 ? ' built in Documents isn\'t' : 's built in Documents aren\'t'} compiled yet, so {unbuilt === 1 ? "it isn't" : "they aren't"} listed — <Link to="/resumes">compile</Link> to send {unbuilt === 1 ? 'it' : 'them'}.
              </div>
            )}
          </div>
          <div className="cp-group">
            <div className="cp-group-h"><span className="cp-group-t">What to send</span></div>
            <div className="seg">
              {([['both', 'Email + cover letter'], ['email', 'Email only'], ['cover', 'Cover letter only']] as const).map(([k, l]) => (
                <button key={k} type="button" className={`seg-btn ${mode === k ? 'active' : ''}`} onClick={() => setMode(k)}>{l}</button>
              ))}
            </div>
          </div>
          <button className="btn btn-primary" style={{ marginTop: 16, width: '100%', justifyContent: 'center' }} onClick={send}
            disabled={sending || !hasContent || !resumeChoice}>
            {sending ? <span className="spinner" /> : <Icon name="send" size={14} />}
            {!resumeChoice ? ' Choose a résumé to send' : ` Send ${mode === 'email' ? 'email' : mode === 'cover' ? 'cover letter' : 'email + cover letter'} to ${to || 'recipient'}`}
          </button>
        </div>

        {/* Step 4 — WhatsApp */}
        <div className="card card-pad">
          <div className="step-head">
            <span className="step-num">4</span>
            <div><div className="step-title">Send on WhatsApp</div><div className="step-sub">Opens WhatsApp with a short message ready, addressed to the recruiter — you press Send. Your résumé and cover letter go as links; WhatsApp can't attach files this way.</div></div>
          </div>
          <div className="grid2">
            <label className="field">Recruiter's WhatsApp number
              <input className="input" inputMode="tel" value={phone} onChange={(e) => { setPhone(e.target.value); touch('phone'); }} placeholder="+91 98765 43210" />
              <span className="field-hint">A 10-digit number gets +{myCountryCode} in front.</span>
            </label>
            <label className="field">Sent from
              <input className="input" value={myWhatsapp || 'Not set'} readOnly aria-readonly="true" />
              <span className="field-hint">The WhatsApp signed in on this device sends it. Change your number in <Link to="/profile">Profile → Personal</Link>.</span>
            </label>
          </div>
          <label className="field" style={{ marginTop: 14 }}>Message
            <textarea className="input" rows={6} value={waMessage} onChange={(e) => setWaMessage(e.target.value)}
              placeholder="Generate fills in a short WhatsApp message here — or write your own." />
          </label>
          <div className="cp-checks">
            <label className={`check-row ${!chosenResume ? 'is-off' : ''}`}>
              <input type="checkbox" checked={waLinkResume} disabled={!chosenResume} onChange={(e) => setWaResume(e.target.checked)} />
              <span>{chosenResume ? <>Link my résumé — “{chosenResume.name}”</> : <>Link my résumé <span className="faint">(choose a library résumé in step 3)</span></>}</span>
            </label>
            <label className={`check-row ${!coverLetter ? 'is-off' : ''}`}>
              <input type="checkbox" checked={waCover && !!coverLetter} disabled={!coverLetter} onChange={(e) => setWaCover(e.target.checked)} />
              <span>Link my cover letter {!coverLetter && <span className="faint">(generate one first)</span>}</span>
            </label>
          </div>
          <div className="row" style={{ marginTop: 16, gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={openWhatsapp} disabled={waBusy || !phone.trim() || !waMessage.trim()}>
              {waBusy ? <span className="spinner" /> : <Icon name="chat" size={14} />} Open in WhatsApp{phone.trim() ? ` for ${phone.trim()}` : ''}
            </button>
            <button className="btn btn-ghost" onClick={previewOnMyPhone} disabled={!waMessage.trim()} title="Opens a chat with your own number so you can see the message first">
              <Icon name="phone" size={14} /> Preview on my phone
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
