import { useEffect, useState } from 'react';
import { api, getAdminToken, setAdminToken } from '../api/client';
import { useToast } from '../lib/ui';

type AiStatus = { enabled: boolean; provider: string; remainingToday: number; providers: { provider: string; configured: boolean }[] };

export function SettingsPage() {
  const toast = useToast();
  const [token, setTok] = useState(getAdminToken());
  const [checking, setChecking] = useState(false);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; ms?: number; error?: string }>>({});

  const loadAi = () => api.aiStatus().then(setAi).catch(() => {});
  useEffect(() => { loadAi(); }, []);

  const save = () => { setAdminToken(token.trim()); toast('Token saved locally', 'success'); };
  const test = async () => {
    setAdminToken(token.trim()); setChecking(true);
    try { await api.health(); toast('Connected — token works ✓', 'success'); }
    catch (e) { toast(`Failed: ${(e as Error).message}`, 'error'); }
    finally { setChecking(false); }
  };

  const switchModel = async (provider: string) => {
    try { const r = await api.aiSetProvider(provider); toast(`AI model: ${r.provider}`, 'success'); loadAi(); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const testModel = async (provider: string) => {
    setTesting(provider);
    try {
      const r = await api.aiTest(provider);
      setResults((x) => ({ ...x, [provider]: { ok: r.ok, ms: r.ms, error: r.error } }));
      toast(r.ok ? `${provider} OK (${r.ms}ms)` : `${provider}: ${r.error}`, r.ok ? 'success' : 'error');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setTesting(null); }
  };

  const MODELS = [
    { id: 'auto', label: 'Auto', desc: 'first configured (Groq → Gemini → Ollama)' },
    { id: 'groq', label: 'Groq', desc: 'llama-3.3-70b · fast' },
    { id: 'gemini', label: 'Gemini', desc: 'gemini-2.5-flash' },
    { id: 'ollama', label: 'Ollama', desc: 'local, free' },
  ];

  return (
    <>
      <div className="page-head">
        <div><h1 className="page-title">Settings</h1><div className="page-sub">API connection & AI models</div></div>
      </div>

      <div className="card card-pad section" style={{ maxWidth: 720 }}>
        <div className="section-title"><span className="si">🔌</span>API connection</div>
        <label className="field">API token (X-Api-Token)
          <input className="input" type="password" value={token} onChange={(e) => setTok(e.target.value)} placeholder="matches backend JOBPILOT_API_TOKEN" />
        </label>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={save}>Save token</button>
          <button className="btn" onClick={test} disabled={checking}>{checking ? <span className="spinner" /> : '🔌'} Test connection</button>
        </div>
      </div>

      <div className="card card-pad section" style={{ maxWidth: 720 }}>
        <div className="section-title"><span className="si">🧠</span>AI model
          <span className="section-sub">{ai ? `active: ${ai.provider} · ${ai.remainingToday} calls left today` : ''}</span>
        </div>
        <div className="grid2">
          {MODELS.map((m) => {
            const cfg = m.id === 'auto' ? ai?.enabled : ai?.providers.find((p) => p.provider === m.id)?.configured;
            const active = ai?.provider === m.id;
            const res = results[m.id];
            return (
              <div key={m.id} className="repeat-row" style={{ borderColor: active ? 'var(--accent)' : undefined }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{m.label} {active && <span className="chip">active</span>}</div>
                    <div className="faint" style={{ fontSize: 12 }}>{m.desc}</div>
                  </div>
                  <span className={`badge ${cfg ? 'badge-email' : 'badge-unknown'}`}>{cfg ? 'configured' : 'no key'}</span>
                </div>
                <div className="row" style={{ marginTop: 10, gap: 6 }}>
                  <button className="btn btn-sm" disabled={active} onClick={() => switchModel(m.id)}>Use</button>
                  {m.id !== 'auto' && <button className="btn btn-ghost btn-sm" disabled={testing === m.id} onClick={() => testModel(m.id)}>{testing === m.id ? <span className="spinner" /> : 'Test'}</button>}
                  {res && <span className={res.ok ? 'badge badge-email' : 'badge badge-url'} style={{ fontSize: 11 }}>{res.ok ? `✓ ${res.ms}ms` : `✗ ${(res.error || '').slice(0, 30)}`}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
          Switch affects cover letters, compose, daily picks & the assistant. Keys live in <code>backend/.env</code>.
        </div>
      </div>
    </>
  );
}
