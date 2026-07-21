import { useState } from 'react';
import { api } from '../api/client';
import { isDesktopApp } from '../lib/desktop';
import { useToast } from '../lib/ui';
import { DownloadDesktop } from './DownloadDesktop';
import { Icon } from './Icon';

/**
 * How the local worker gets connected. Two paths:
 *  - Inside the JobPilot desktop app: open the Terminal (next to “Watch live”) and click
 *    Connect — no code to copy. This card just points there.
 *  - In a browser: download the desktop app. A connect code is available under Advanced for
 *    anyone running the standalone worker instead.
 */
export function DesktopSetup({ configured, onChange }: { configured: boolean; onChange?: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [advanced, setAdvanced] = useState(false);

  const issue = async () => {
    try {
      const r = await api.agentIssueToken();
      setCode(r.token);
      onChange?.();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const copy = () => { navigator.clipboard?.writeText(code).then(() => toast('Copied', 'success')).catch(() => {}); };

  // Inside the app there's nothing to install — connecting is one click in the Terminal.
  if (isDesktopApp()) {
    return (
      <div className="card card-pad" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <Icon name="terminal" size={18} style={{ color: 'var(--accent-hi)', flex: 'none', transform: 'translateY(2px)' }} />
        <div>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>
            Connect the automation {configured && <span className="tone tone-green" style={{ marginLeft: 6 }}>connected</span>}
          </div>
          <div className="faint" style={{ fontSize: 13, marginTop: 3, lineHeight: 1.6 }}>
            Open the <b>Terminal</b> (next to “Watch live”) and click <b>Connect</b>. A Chrome window opens so
            you can sign into each portal once — then use the Connect buttons above.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card card-pad">
      <h3 style={{ marginTop: 0 }}>
        Get the JobPilot desktop app {configured && <span className="tone tone-green">connected</span>}
      </h3>
      <p className="faint" style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        The automation runs from a small app on your computer, using your own browser logins — your passwords
        and cookies never reach our servers. Install it, sign in, and click <b>Connect</b> in its built-in
        terminal. That's the whole setup.
      </p>
      <DownloadDesktop />

      <button className="btn btn-sm" style={{ marginTop: 14 }} onClick={() => setAdvanced((v) => !v)}>
        {advanced ? '▾' : '▸'} Advanced — connect a standalone worker
      </button>
      {advanced && (
        <div style={{ marginTop: 10 }}>
          <p className="faint" style={{ fontSize: 12.5, marginTop: 0, lineHeight: 1.6 }}>
            Only needed if you run the command-line worker instead of the app. Generate a code and paste it when
            it asks — once.
          </p>
          <button className="btn btn-sm btn-primary" onClick={issue}>
            {configured ? 'Regenerate connect code' : 'Generate connect code'}
          </button>
          {code && (
            <div style={{ marginTop: 12 }}>
              <div className="row" style={{ gap: 8, alignItems: 'stretch' }}>
                <pre style={{ userSelect: 'all', flex: 1, background: 'var(--bg-elev)', border: '1px solid var(--border)', padding: 10, borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>{code}</pre>
                <button className="btn btn-sm" onClick={copy}>Copy</button>
              </div>
              <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Shown once — regenerating replaces the old one.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
