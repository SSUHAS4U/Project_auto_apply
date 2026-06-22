import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { SavedJob } from '../types';
import { fmtDate, useToast } from '../lib/ui';
import { Modal } from '../components/Modal';

export function SavedJobsPage() {
  const toast = useToast();
  const [saved, setSaved] = useState<SavedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [guide, setGuide] = useState(false);

  const load = () => {
    setLoading(true);
    api.savedJobs().then(setSaved).catch((e) => toast(e.message, 'error')).finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line

  const promote = async (s: SavedJob) => {
    try { await api.promoteSaved(s.id); toast('Promoted → now a tracked application', 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Saved jobs</h1>
          <div className="page-sub">Listings you captured with the browser extension</div>
        </div>
        <button className="btn btn-primary" onClick={() => setGuide(true)}>🧩 Set up the extension</button>
      </div>

      {guide && (
        <Modal title="Set up the JobPilot extension" onClose={() => setGuide(false)} wide
          footer={<button className="btn btn-primary" onClick={() => setGuide(false)}>Got it</button>}>
          <a className="btn btn-primary" href="/jobpilot-extension.zip" download="jobpilot-extension.zip"
            style={{ marginBottom: 14 }}>⬇ Download extension (.zip)</a>
          <ol style={{ lineHeight: 1.8, fontSize: 14, paddingLeft: 18, margin: 0 }}>
            <li><b>Download</b> the zip above and <b>unzip</b> it to a folder you'll keep.</li>
            <li>Open Chrome/Edge/Brave → go to <code>chrome://extensions</code>.</li>
            <li>Turn on <b>Developer mode</b> (top-right toggle).</li>
            <li>Click <b>Load unpacked</b> → select the unzipped <b>jobpilot-extension</b> folder.</li>
            <li>Click the JobPilot icon → <b>Options</b> → enter the backend URL, your <b>email & password</b> → <b>Sign in</b>.</li>
            <li><b>Autofill a form:</b> open a Google/MS Form or job application → click the extension → <b>⚡ Fill this form</b> (it fills, you review &amp; submit).</li>
            <li><b>AI-answer questions:</b> for open-ended questions ("Why do you want to join…?"), a <b>✨ AI answer</b> button appears under each field — or click <b>✨ AI-answer questions</b> in the popup to do them all. Answers are saved so the same question autofills next time.</li>
            <li><b>Save your own answers:</b> type an answer and hit <b>💾 Save</b> under the field to add it to your autofill questions.</li>
            <li><b>Cover letter:</b> click <b>📄 Attach cover letter</b> — it writes one from your profile and attaches the PDF to the upload field (or downloads it if there isn't one).</li>
            <li><b>Save a job:</b> on a LinkedIn/Naukri/Indeed posting, click the floating <b>🔖 Save to JobPilot</b> button — it appears here, ready to <b>Promote</b>.</li>
          </ol>
          <div className="faint" style={{ fontSize: 12, marginTop: 12 }}>
            The extension needs the same account as the dashboard. It fills forms but never auto-submits to LinkedIn/Naukri (keeps your accounts safe).
          </div>
        </Modal>
      )}

      <div className="card card-pad" style={{ marginBottom: 18, display: 'flex', gap: 14, alignItems: 'flex-start', borderLeft: '3px solid var(--accent)' }}>
        <span style={{ fontSize: 22 }}>🔖</span>
        <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
          <b>What this is:</b> when you browse <b>LinkedIn / Naukri / Indeed</b> and find a job worth keeping,
          click the extension's <b>“Save to JobPilot”</b> button — it lands here. Then <b>Promote</b> a saved
          listing to turn it into a tracked application (it appears on the <b>Applications</b> board and gets a match score).
          <div className="faint" style={{ marginTop: 4 }}>This is how jobs from sites we can't legally fetch server-side still make it into your tracker.</div>
        </div>
      </div>

      {loading ? <div className="empty"><span className="spinner" /></div>
        : saved.length === 0 ? (
          <div className="card card-pad empty">
            <div className="big">🗂️</div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>No saved jobs yet</div>
            <div className="muted" style={{ maxWidth: 460, margin: '0 auto' }}>
              Install the extension (Settings → see the guide), open a job on LinkedIn/Naukri/Indeed,
              and hit <b>Save to JobPilot</b>. It’ll show up here ready to promote.
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: 14 }}>
            {saved.map((s) => (
              <div key={s.id} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <a href={s.url} target="_blank" rel="noreferrer" className="job-title" style={{ fontSize: 15 }}>{s.title ?? 'Untitled listing'}</a>
                  <span className="chip">{s.sourceSite ?? 'web'}</span>
                </div>
                <div className="muted" style={{ fontSize: 13 }}>{s.company ?? '—'}{s.location ? ` · ${s.location}` : ''}</div>
                <div className="faint" style={{ fontSize: 12 }}>Captured {fmtDate(s.createdAt)}</div>
                <div className="row" style={{ marginTop: 'auto', paddingTop: 8, gap: 8 }}>
                  {s.promotedJobId
                    ? <span className="badge badge-ats">✓ Promoted</span>
                    : <button className="btn btn-primary btn-sm" onClick={() => promote(s)}>Promote to tracker</button>}
                  <a className="btn btn-ghost btn-sm" href={s.url} target="_blank" rel="noreferrer">Open ↗</a>
                </div>
              </div>
            ))}
          </div>
        )}
    </>
  );
}
