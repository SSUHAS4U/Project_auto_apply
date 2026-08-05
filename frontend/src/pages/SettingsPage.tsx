import { useEffect, useState } from 'react';
import { api, getAdminToken, setAdminToken, isAdminUI } from '../api/client';
import { useToast } from '../lib/ui';
import { Icon } from '../components/Icon';

// Derived from the client rather than restated here — a second hand-written copy of the shape
// is exactly how this page came to render fields the endpoint had stopped sending.
type AiStatus = Awaited<ReturnType<typeof api.aiStatus>>;

export function SettingsPage() {
  const toast = useToast();
  const [token, setTok] = useState(getAdminToken());
  const [checking, setChecking] = useState(false);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; ms?: number; error?: string }>>({});

  const loadAi = () => api.aiStatus().then(setAi).catch(() => {});
  useEffect(() => { loadAi(); }, []);
  // A resting provider counts down, so refresh while any of them is. Polling only while
  // something is actually happening keeps an idle Settings tab silent.
  const anyResting = (ai?.providers ?? []).some((p) => p.restingSeconds > 0);
  useEffect(() => {
    if (!anyResting) return;
    const t = setInterval(loadAi, 5000);
    return () => clearInterval(t);
  }, [anyResting]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Model names are NOT listed here — they come from the backend, which reads the real
  // configuration. Hard-coding them meant changing a model left this panel naming the old one.
  const MODELS = [
    { id: 'groq', label: 'Groq', note: 'fast, generous free tier' },
    { id: 'gemini', label: 'Gemini', note: 'large free quota' },
    { id: 'ollama', label: 'Ollama', note: 'runs locally, no key' },
    { id: 'gateway', label: 'Gateway', note: 'OpenAI-compatible endpoint' },
  ];
  const byId = (id: string) => ai?.providers.find((p) => p.provider === id);
  const isAuto = (ai?.provider ?? 'auto') === 'auto';

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
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
          <span className="section-sub">
            {ai ? `${ai.remainingToday < 0 ? 'unlimited' : ai.remainingToday + ' calls left today'}` : ''}
          </span>
        </div>

        {/* ── The mode. Auto is the recommended path and explains what it actually does now:
            it rotates across every configured provider and rests whichever one hits a rate
            limit. It used to say "first configured", which stopped being true. ── */}
        <div className={`ai-mode ${isAuto ? 'on' : ''}`}>
          <label className="ai-mode-pick">
            <input type="radio" name="aimode" checked={isAuto} onChange={() => switchModel('auto')} />
            <span>
              <b>Auto</b> <span className="tone tone-indigo">recommended</span>
              <span className="ai-mode-desc">
                Shares the work across every provider below and rests any that hits a rate limit,
                so one free tier running out doesn’t stop the automation.
              </span>
              {isAuto && ai?.order?.length ? (
                <span className="ai-order">
                  next: {ai.order.map((o, i) => (
                    <span key={o}>{i > 0 && <span className="ai-arrow"> → </span>}<code>{o}</code></span>
                  ))}
                </span>
              ) : null}
            </span>
          </label>
          {!isAuto && (
            <div className="ai-pinned">
              Pinned to <b>{ai?.provider}</b> — every request goes there and the others stay idle.
            </div>
          )}
        </div>

        <div className="ai-grid">
          {MODELS.map((m) => {
            const p = byId(m.id);
            const cfg = !!p?.configured;
            const pinned = ai?.provider === m.id;
            const resting = (p?.restingSeconds ?? 0) > 0;
            const res = results[m.id];
            return (
              <div key={m.id} className={`ai-card ${!cfg ? 'off' : ''} ${pinned ? 'pinned' : ''}`}>
                <div className="ai-card-head">
                  <span className={`ai-led ${!cfg ? 'grey' : resting ? 'amber' : 'green'}`} />
                  <span className="ai-card-name">{m.label}</span>
                  {pinned && <span className="tone tone-indigo">pinned</span>}
                  {cfg && isAuto && !resting && <span className="tone tone-green">in rotation</span>}
                  {resting && <span className="tone tone-amber">resting {p!.restingSeconds}s</span>}
                  {!cfg && <span className="tone tone-slate">no key</span>}
                </div>
                <div className="ai-card-model">{cfg && p?.model ? p.model : m.note}</div>
                <div className="ai-card-actions">
                  <button className="btn btn-ghost btn-sm" disabled={!cfg || testing === m.id}
                    onClick={() => testModel(m.id)}>
                    {testing === m.id ? <span className="spinner" /> : 'Test'}
                  </button>
                  {cfg && (pinned
                    ? <button className="btn btn-sm" onClick={() => switchModel('auto')}>Unpin</button>
                    : <button className="btn btn-sm" onClick={() => switchModel(m.id)}>Use only this</button>)}
                  {res && <span className={`tone ${res.ok ? 'tone-green' : 'tone-red'}`}>
                    {res.ok ? `${res.ms}ms` : (res.error || '').slice(0, 26)}</span>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="faint" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.6 }}>
          This is the only place the model is chosen — it applies to <b>everything that uses AI</b>:
          the automation’s job-fit and outreach decisions, cover letters, compose, résumé analysis,
          daily picks and the assistant. Keys live in <code>backend/.env</code>.
          Usage is <b>unlimited</b> by default (the free tiers self-rate-limit) — set
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

      <ResetDataCard />
    </div>
  );
}

/** Danger zone — wipe automation activity for a clean test run. */
function ResetDataCard() {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    setBusy(true);
    try {
      await api.agentReset();
      toast('Automation data cleared — dashboard is now at zero.', 'success');
      setConfirming(false);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="card card-pad section" style={{ maxWidth: 720, borderColor: 'color-mix(in srgb, var(--red) 35%, var(--border))' }}>
      <div className="section-title"><span className="si" style={{ background: 'color-mix(in srgb, var(--red) 14%, transparent)', color: 'var(--red)' }}><Icon name="trash" size={15} /></span>Reset automation data
        <span className="section-sub">start a clean test run</span>
      </div>
      <div className="faint" style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
        Clears the activity feed, run history, sent messages, network contacts and application
        packages — so every dashboard tile goes back to <b>0</b> for a fresh test of LinkedIn &amp;
        Indeed. Your <b>profile, résumé and the found-jobs pool are not touched.</b> This can't be undone.
      </div>
      {confirming ? (
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-danger-solid btn-sm" onClick={reset} disabled={busy}>
            {busy ? <><span className="spinner" /> Clearing…</> : <><Icon name="trash" size={13} /> Yes, wipe it</>}
          </button>
          <button className="btn btn-sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
        </div>
      ) : (
        <button className="btn btn-danger btn-sm" onClick={() => setConfirming(true)}><Icon name="trash" size={13} /> Reset automation data</button>
      )}
    </div>
  );
}
