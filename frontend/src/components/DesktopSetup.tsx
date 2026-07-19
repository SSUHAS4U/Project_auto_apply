import { useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../lib/ui';
import { DownloadDesktop } from './DownloadDesktop';

/**
 * JobPilot Desktop onboarding — download + one-time connect code. Lives on the
 * Connections page (it's the thing that makes the Connect buttons work); the Agent page
 * links here instead of duplicating it.
 */
export function DesktopSetup({ configured, onChange }: { configured: boolean; onChange?: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const issue = async () => {
    try {
      const r = await api.agentIssueToken();
      setCode(r.token);
      toast('Connect code generated — paste it into JobPilot Desktop.', 'success');
      onChange?.();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const copy = () => { navigator.clipboard?.writeText(code).then(() => toast('Copied', 'success')).catch(() => {}); };

  return (
    <div className="card card-pad">
      <h3 style={{ marginTop: 0 }}>Set up JobPilot Desktop {configured && <span className="tone tone-green">connected</span>}</h3>
      <p className="faint" style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        JobPilot Desktop is a tiny app that runs on your computer — the same idea as VS Code being installed.
        It opens a real browser so the agent can apply for you, using your own logins. Your passwords and
        cookies stay on your machine and never reach our servers. You set it up <b>once</b>:
      </p>
      <ol style={{ fontSize: 13.5, lineHeight: 1.9 }}>
        <li><b>Download JobPilot Desktop</b> for your computer and open it (Windows may warn on an unknown
          app — choose “More info → Run anyway”).</li>
        <li>Generate your connect code below and paste it when the app asks (just once).</li>
        <li>Done. A browser opens — now use the <b>Connect</b> buttons above to sign into each portal.</li>
      </ol>
      <DownloadDesktop />
      <div style={{ height: 12 }} />
      <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 4 }}>
        <button className="btn btn-primary btn-sm" onClick={issue}>
          {configured ? 'Regenerate connect code' : 'Generate connect code'}
        </button>
        {configured && <span className="faint" style={{ fontSize: 12 }}>Already connected — regenerate only if you're setting up a new computer.</span>}
      </div>
      {code && (
        <div style={{ marginTop: 12 }}>
          <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>Your connect code (paste it into JobPilot Desktop):</div>
          <div className="row" style={{ gap: 8, alignItems: 'stretch' }}>
            <pre style={{ userSelect: 'all', flex: 1, background: 'var(--bg-elev)', border: '1px solid var(--border)', padding: 10, borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>{code}</pre>
            <button className="btn btn-sm" onClick={copy}>Copy</button>
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Shown once — regenerating replaces the old one.</div>
        </div>
      )}
    </div>
  );
}
