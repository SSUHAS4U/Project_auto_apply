import { useState } from 'react';
import { api, getToken, setToken } from '../api/client';
import { useToast } from '../lib/ui';

export function SettingsPage() {
  const toast = useToast();
  const [token, setTok] = useState(getToken());
  const [checking, setChecking] = useState(false);

  const save = () => { setToken(token.trim()); toast('Token saved locally', 'success'); };

  const test = async () => {
    setToken(token.trim());
    setChecking(true);
    try { await api.health(); toast('Connected — token works ✓', 'success'); }
    catch (e) { toast(`Failed: ${(e as Error).message}`, 'error'); }
    finally { setChecking(false); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <div className="page-sub">API connection for this dashboard</div>
        </div>
      </div>

      <div className="card card-pad" style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label className="field">API token (X-Api-Token)
          <input className="input" type="password" value={token} onChange={(e) => setTok(e.target.value)}
            placeholder="matches backend JOBPILOT_API_TOKEN" />
        </label>
        <div className="faint" style={{ fontSize: 12 }}>
          Stored in <code>localStorage</code> only. Backend base URL: <code>{import.meta.env.VITE_API_BASE ?? 'http://localhost:8080'}</code>
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={save}>Save token</button>
          <button className="btn" onClick={test} disabled={checking}>{checking ? <span className="spinner" /> : '🔌'} Test connection</button>
        </div>
      </div>
    </>
  );
}
