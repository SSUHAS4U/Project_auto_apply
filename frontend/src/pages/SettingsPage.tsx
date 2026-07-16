import { useEffect, useState } from 'react';
import { api, getAdminToken, setAdminToken, isAdminUI } from '../api/client';
import { useToast } from '../lib/ui';
import { Icon } from '../components/Icon';

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

  const [emailTo, setEmailTo] = useState('');
  const [emailing, setEmailing] = useState(false);

  const save = () => { setAdminToken(token.trim()); toast('Token saved locally', 'success'); };
  const test = async () => {
    setAdminToken(token.trim()); setChecking(true);
    try { await api.health(); toast('Connected — token works ✓', 'success'); }
    catch (e) { toast(`Failed: ${(e as Error).message}`, 'error'); }
    finally { setChecking(false); }
  };

  const sendTestEmail = async () => {
    setEmailing(true);
    try {
      const r = await api.testEmail(emailTo.trim());
      if (r.ok) toast(`Test email sent to ${r.sentTo} ✓ — check your inbox`, 'success');
      else toast(`Email failed: ${r.error}`, 'error');
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setEmailing(false); }
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
        <div className="section-title"><span className="si"><Icon name="link" size={15} /></span>API connection</div>
        <label className="field">API token (X-Api-Token)
          <input className="input" type="password" value={token} onChange={(e) => setTok(e.target.value)} placeholder="matches backend JOBPILOT_API_TOKEN" />
        </label>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={save}>Save token</button>
          <button className="btn" onClick={test} disabled={checking}>{checking ? <span className="spinner" /> : <Icon name="link" size={14} />} Test connection</button>
        </div>
      </div>

      {isAdminUI() && (
        <div className="card card-pad section" style={{ maxWidth: 720 }}>
          <div className="section-title"><span className="si"><Icon name="mail" size={15} /></span>Email
            <span className="section-sub">verify the mail transport (Brevo / SMTP) works end-to-end</span>
          </div>
          <label className="field">Send a test email to
            <input className="input" type="email" value={emailTo} onChange={(e) => setEmailTo(e.target.value)}
              placeholder="leave blank to use your digest address" />
          </label>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={sendTestEmail} disabled={emailing}>
              {emailing ? <span className="spinner" /> : <Icon name="mail" size={14} />} Send test email
            </button>
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
            On Render set <code>JOBPILOT_BREVO_API_KEY</code> + <code>JOBPILOT_MAIL_FROM</code> to send over HTTPS
            (Render blocks SMTP). If it fails, check Brevo → Authorised IPs and that your sender is verified.
          </div>
        </div>
      )}

      <div className="card card-pad section" style={{ maxWidth: 720 }}>
        <div className="section-title"><span className="si"><Icon name="bot" size={15} /></span>AI model
          <span className="section-sub">{ai ? `active: ${ai.provider} · ${ai.remainingToday < 0 ? 'unlimited' : ai.remainingToday + ' calls left today'}` : ''}</span>
        </div>
        <div className="grid2">
          {MODELS.map((m) => {
            const cfg = m.id === 'auto' ? ai?.enabled : ai?.providers.find((p) => p.provider === m.id)?.configured;
            const active = ai?.provider === m.id;
            const res = results[m.id];
            return (
              <div key={m.id} className={`opt-card ${active ? 'active' : ''}`}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 7 }}>
                      <span style={{ fontWeight: 700, fontSize: 14.5 }}>{m.label}</span>
                      {active && <span className="tone tone-indigo">active</span>}
                    </div>
                    <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{m.desc}</div>
                  </div>
                  <span className={`tone ${cfg ? 'tone-green' : 'tone-slate'}`}>{cfg ? 'configured' : 'no key'}</span>
                </div>
                <div className="row" style={{ marginTop: 12, gap: 6, alignItems: 'center' }}>
                  <button className={`btn btn-sm ${active ? '' : 'btn-primary'}`} disabled={active} onClick={() => switchModel(m.id)}>{active ? 'In use' : 'Use this'}</button>
                  {m.id !== 'auto' && <button className="btn btn-ghost btn-sm" disabled={testing === m.id} onClick={() => testModel(m.id)}>{testing === m.id ? <span className="spinner" /> : 'Test'}</button>}
                  {res && <span className={`tone ${res.ok ? 'tone-green' : 'tone-red'}`}>{res.ok ? `${res.ms}ms` : `${(res.error || '').slice(0, 28)}`}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
          Switch affects cover letters, compose, daily picks & the assistant. Keys live in <code>backend/.env</code>.
          AI usage is <b>unlimited</b> by default (Groq & Gemini free tiers self-rate-limit) — set
          <code> JOBPILOT_AI_DAILY_LIMIT</code> only if you want a hard cap.
        </div>
      </div>

      <div className="card card-pad section" style={{ maxWidth: 720 }}>
        <div className="section-title"><span className="si"><Icon name="bot" size={15} /></span>Connect local Ollama to the cloud app
          <span className="section-sub">run your own free model from the deployed backend</span>
        </div>
        <div className="faint" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
          The deployed backend can't reach <code>localhost:11434</code> on your laptop. Expose Ollama
          through a <b>secure tunnel</b> (locked to a secret header) and point the backend at it.
          Don't need this? Just use <b>Groq</b> — free, fast, already cloud-ready.
        </div>
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 600, marginBottom: 8 }}>Step-by-step (Cloudflare Tunnel, free)</summary>
          <ol style={{ lineHeight: 1.8, fontSize: 13.5, paddingLeft: 18, margin: '8px 0' }}>
            <li><b>Run Ollama</b> on your laptop: <code>ollama serve</code> then <code>ollama pull llama3.1</code> (keep the laptop on).</li>
            <li><b>Install cloudflared:</b> <code>winget install Cloudflare.cloudflared</code>.</li>
            <li><b>Open a tunnel:</b> <code>cloudflared tunnel --url http://localhost:11434</code> — it prints a public <code>https://…trycloudflare.com</code> URL.</li>
            <li><b>For real auth</b> (recommended): in Cloudflare Zero Trust → Access, add a self-hosted app for that host and create a <b>Service Token</b>.</li>
            <li><b>Set these env vars on Render</b> (backend → Environment), then redeploy:
              <pre className="code-block" style={{ marginTop: 6 }}>{`JOBPILOT_AI_PROVIDER=ollama
JOBPILOT_OLLAMA_URL=https://your-host.trycloudflare.com
JOBPILOT_OLLAMA_MODEL=llama3.1
JOBPILOT_OLLAMA_AUTH_HEADER=CF-Access-Client-Id
JOBPILOT_OLLAMA_AUTH_VALUE=<your-service-token>`}</pre>
            </li>
            <li>Come back here → <b>AI model → Ollama → Test</b>. If your laptop is off, the app auto-falls back to Groq/Gemini.</li>
          </ol>
          <div className="faint" style={{ fontSize: 12 }}>
            Security: never expose port 11434 directly; the backend sends your secret header on every call.
            Full guide: <code>docs/OLLAMA_TUNNEL.md</code>.
          </div>
        </details>
      </div>
    </>
  );
}
