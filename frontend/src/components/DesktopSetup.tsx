import { useState } from 'react';
import { api } from '../api/client';
import { isDesktopApp } from '../lib/desktop';
import { useToast } from '../lib/ui';
import { DownloadDesktop } from './DownloadDesktop';
import { TerminalConsole } from './DesktopTerminal';
import { Icon } from './Icon';

/**
 * How the local worker gets connected. Two paths:
 *  - Inside the JobPilot desktop app: the Terminal is embedded in this card — click Connect,
 *    no code to copy.
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

  // Inside the app there's nothing to install. The terminal is embedded RIGHT HERE rather
  // than pointing elsewhere — the old copy sent you to a button "next to Watch live", and
  // Watch live no longer exists, so the instruction led nowhere.
  if (isDesktopApp()) {
    return (
      <div className="card card-pad">
        <div className="card-title">
          <Icon name="terminal" size={16} /> Connect the automation
          {configured && <span className="tone tone-green" style={{ marginLeft: 6 }}>connected</span>}
        </div>
        <div className="faint" style={{ fontSize: 13, marginTop: -2, marginBottom: 12, lineHeight: 1.6 }}>
          Click <b>Connect</b> below. A Chrome window opens so you can sign into LinkedIn and Indeed once —
          the session is remembered. Then use the Connect buttons above. Everything the automation does
          is printed here live.
        </div>
        <div style={{ height: 340 }}><TerminalConsole /></div>
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
