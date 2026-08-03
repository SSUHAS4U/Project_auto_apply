import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AgentStatus, PortalConnection } from '../types';
import { fmtDate, useToast } from '../lib/ui';
import { Icon } from '../components/Icon';
import { DesktopSetup } from '../components/DesktopSetup';
import { DownloadDesktop } from '../components/DownloadDesktop';
import { isDesktopApp } from '../lib/desktop';

/**
 * Connections — the board of everything the agent works through: portal sessions (sign-in
 * stays on the user's machine) + email, and the flow-control toggles that govern what the
 * automation may do. Desktop-app setup lives at the bottom of this page (DesktopSetup).
 */

const PORTALS: Record<string, { name: string; color: string; letter: string; sub: string; parked?: boolean }> = {
  linkedin: { name: 'LinkedIn', color: '#0A66C2', letter: 'in', sub: 'Easy Apply · connections · messages' },
  indeed: { name: 'Indeed', color: '#2557A7', letter: 'i', sub: 'Indeed Apply on your session' },
};

const STATUS: Record<string, { label: string; tone: string }> = {
  connected: { label: 'Active', tone: 'green' },
  connecting: { label: 'Waiting for sign-in…', tone: 'amber' },
  disconnected: { label: 'Not connected', tone: 'slate' },
};

const FLOWS: { key: string; label: string; sub: string; ico: string }[] = [
  { key: 'autoEasyApply', label: 'Auto Easy Apply', sub: 'Run the apply pipeline (search → relevance → apply) automatically.', ico: 'bolt' },
  { key: 'autoEmail', label: 'Auto-email recruiters', sub: 'Send tailored emails when a recruiter address is available.', ico: 'mail' },
  { key: 'autoMessage', label: 'Auto-message connections', sub: 'Message recruiters after they accept your connection request.', ico: 'send' },
];

export function ConnectionsPage() {
  const toast = useToast();
  const nav = useNavigate();
  const [conns, setConns] = useState<PortalConnection[]>([]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [flows, setFlows] = useState<Record<string, boolean>>({});
  const [template, setTemplate] = useState('');
  const [savingTpl, setSavingTpl] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    api.agentConnections().then(setConns).catch(() => {});
    api.agentStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    api.agentFlows().then(setFlows).catch(() => {});
    api.agentMessageTemplate().then((r) => setTemplate(r.template)).catch(() => {});
    const t = setInterval(load, 4000); // live: flips to Active seconds after you sign in
    return () => clearInterval(t);
  }, [load]);

  const saveTemplate = async () => {
    setSavingTpl(true);
    try { await api.agentSetMessageTemplate(template); toast('Message template saved.', 'success'); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setSavingTpl(false); }
  };

  const online = status?.workerOnline ?? false;
  // The desktop app is the only place portal sessions exist, so it owns status + connect.
  const inApp = isDesktopApp();

  const connect = async (portal: string) => {
    // In-app the worker auto-starts, but it takes a moment on a cold launch.
    if (!online) { toast('The automation is still starting — try again in a few seconds.', 'error'); return; }
    setBusy(portal);
    try {
      await api.agentConnect(portal);
      toast(`Opening ${PORTALS[portal].name} sign-in — log in there once.`, 'success');
      load();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(''); }
  };
  const disconnect = async (portal: string) => {
    setBusy(portal);
    try { await api.agentDisconnect(portal); toast(`${PORTALS[portal].name} disconnected.`, 'success'); load(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(''); }
  };
  const toggleFlow = async (key: string) => {
    const next = { ...flows, [key]: !flows[key] };
    setFlows(next); // optimistic
    try { setFlows(await api.agentSetFlows({ [key]: next[key] })); }
    catch (e) { toast((e as Error).message, 'error'); setFlows(flows); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Connections</h1>
          <div className="page-sub">
            The portals and channels your agent works through. Sign-in happens in your own browser and
            stays on your machine — this server never sees your password or cookies.
          </div>
        </div>
        {/* Live status is only truthful INSIDE the desktop app — that's where the worker and the
            portal sessions actually live. In a browser it was reporting a state it can't see, so
            the web build shows guidance instead of a status it would only get wrong. */}
        {inApp && (
          <span className={`tone ${online ? 'tone-green live-pulse' : 'tone-slate'}`} style={{ padding: '6px 12px' }}>
            <span className="live-dot" /> {online ? 'Automation running' : 'Automation starting…'}
          </span>
        )}
      </div>

      {!inApp && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <div className="section-title" style={{ marginBottom: 8 }}>
            <Icon name="download" size={15} /> Connecting happens in the desktop app
          </div>
          <div className="faint" style={{ fontSize: 13.5, lineHeight: 1.65, marginBottom: 14 }}>
            Your LinkedIn / Indeed sign-in stays on your own machine, so the connection is made in
            the JobPilot Desktop app — never here. Three steps, once:
            <ol style={{ margin: '10px 0 0', paddingLeft: 20 }}>
              <li>Download and install JobPilot Desktop.</li>
              <li>Open it and go to <b>Connections</b> — click <b>Connect</b> for LinkedIn and Indeed,
                  then sign in normally in the window that opens.</li>
              <li>That's it. The sign-in is remembered, and the automation starts by itself every
                  time you open the app.</li>
            </ol>
          </div>
          <DownloadDesktop />
        </div>
      )}

      <div className="conn-grid">
        {Object.keys(PORTALS).map((key) => {
          const p = PORTALS[key];
          const c = conns.find((x) => x.portal === key);
          const connected = c?.status === 'connected';
          const s = STATUS[c?.status ?? 'disconnected'] ?? STATUS.disconnected;
          return (
            <div key={key} className="card conn-card">
              <div className="conn-top">
                <div className="conn-logo" style={{ background: p.color }}>{p.letter}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="conn-name">{p.name}</div>
                  <div className="faint" style={{ fontSize: 12.5 }}>{p.sub}</div>
                </div>
                {inApp && (
                  <span className={`tone tone-${connected ? 'green live-pulse' : s.tone}`}>
                    {connected && <span className="live-dot" />}{s.label}
                  </span>
                )}
              </div>
              {/* Connect/Disconnect belong to the desktop app — the browser can't drive a sign-in
                  on your machine, so showing the buttons here would only ever fail. */}
              {!inApp ? (
                <div className="faint" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                  Connect this from <b>JobPilot Desktop → Connections</b>. Signing in once is enough —
                  it's remembered from then on.
                </div>
              ) : connected ? (
                <button className="btn" style={{ width: '100%' }} onClick={() => disconnect(key)} disabled={busy === key}>
                  Disconnect {p.name}
                </button>
              ) : (
                <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => connect(key)}
                  disabled={busy === key || c?.status === 'connecting'}>
                  {busy === key || c?.status === 'connecting' ? <span className="spinner" /> : <Icon name="link" size={14} />}{' '}
                  {c?.status === 'connecting' ? 'Waiting for sign-in…' : `Connect ${p.name}`}
                </button>
              )}
              {inApp && c?.detail && !connected && (
                <div className={c.status === 'connecting' ? 'faint' : 't-amber'} style={{ fontSize: 12, marginTop: 8 }}>{c.detail}</div>
              )}
              {inApp && c?.updatedAt && <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>Updated {fmtDate(c.updatedAt)}</div>}
            </div>
          );
        })}

        {/* Email — configured in Settings (Brevo/SMTP), used for email-type applications */}
        <div className="card conn-card">
          <div className="conn-top">
            <div className="conn-logo" style={{ background: '#DB4437' }}><Icon name="mail" size={20} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="conn-name">Email</div>
              <div className="faint" style={{ fontSize: 12.5 }}>Email-type applications &amp; outreach</div>
            </div>
            <span className="tone tone-green">Active</span>
          </div>
          <button className="btn" style={{ width: '100%' }} onClick={() => nav('/settings')}>Manage in Settings</button>
        </div>

        {/* Desktop app — the engine that runs the portal automation on the user's PC */}
        <div className="card conn-card">
          <div className="conn-top">
            <div className="conn-logo" style={{ background: 'linear-gradient(135deg, var(--accent-hi), var(--accent))' }}>
              <Icon name="terminal" size={18} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="conn-name">JobPilot Desktop</div>
              <div className="faint" style={{ fontSize: 12.5 }}>Runs the automation on your computer</div>
            </div>
            <span className={`tone tone-${online ? 'green live-pulse' : 'slate'}`}>
              {online && <span className="live-dot" />}{online ? 'Running' : 'Offline'}
            </span>
          </div>
          <button className="btn" style={{ width: '100%' }}
            onClick={() => document.getElementById('desktop-setup')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            {online ? 'Manage below' : 'Set up the app'}
          </button>
        </div>
      </div>

      {/* Flow controls — what the automation is allowed to do */}
      <div className="card card-pad" style={{ marginTop: 18 }}>
        <div className="card-title"><Icon name="gear" size={15} /> Flow controls</div>
        <div className="faint" style={{ fontSize: 12.5, marginTop: -4, marginBottom: 10 }}>
          Master switches for what the agent may do on your behalf.
        </div>
        {FLOWS.map((f, i) => (
          <div key={f.key} className="flow-row" style={i === FLOWS.length - 1 ? { borderBottom: 'none' } : undefined}>
            <span className="flow-ico"><Icon name={f.ico} size={16} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 650, fontSize: 14 }}>{f.label}</div>
              <div className="faint" style={{ fontSize: 12.5 }}>{f.sub}</div>
            </div>
            <button role="switch" aria-checked={!!flows[f.key]} aria-label={f.label}
              className={`switch ${flows[f.key] ? 'on' : ''}`} onClick={() => toggleFlow(f.key)}>
              <span className="knob" />
            </button>
          </div>
        ))}
      </div>

      {/* Connection-message template — sent automatically with connection requests when
          Auto-message is on. Replies to recruiters always stay manual (you reply). */}
      <div className="card card-pad" style={{ marginTop: 18 }}>
        <div className="card-title"><Icon name="send" size={15} /> Connection message template</div>
        <div className="faint" style={{ fontSize: 12.5, marginTop: -4, marginBottom: 8 }}>
          Sent automatically with connection requests when <b>Auto-message</b> is on. Placeholders:
          <code> [Name]</code> <code>[Role]</code> <code>[Company]</code> <code>[MyName]</code> <code>[MyRole]</code>.
          When a recruiter replies, the automation stops — you reply from your own account.
        </div>
        <textarea className="input" rows={4} value={template} onChange={(e) => setTemplate(e.target.value)}
          placeholder={"Hi [Name], I'm [MyName], a [MyRole]. I'm actively looking for [Role] roles and would love to connect regarding openings at [Company]."} />
        <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={saveTemplate} disabled={savingTpl}>
          {savingTpl ? <span className="spinner" /> : <Icon name="check" size={13} />} Save template
        </button>
      </div>

      {/* Desktop onboarding is for people who DON'T have the app yet — inside the app it's
          noise (it's installed, and the worker connects itself). */}
      {!inApp && (
        <div id="desktop-setup" style={{ marginTop: 16, scrollMarginTop: 16 }}>
          <DesktopSetup configured={status?.workerConfigured ?? false} onChange={load} />
        </div>
      )}

      <div className="card card-pad" style={{ marginTop: 16, fontSize: 13 }}>
        <b>What happens when you click Connect</b>
        <p className="faint" style={{ margin: '6px 0 0', lineHeight: 1.7 }}>
          A browser opens on that portal's login page. You sign in once — the login is saved on your computer,
          never on our servers — and the card turns <b className="t-green">Active</b> within seconds. From then
          on the agent can search and apply there for you.
        </p>
      </div>
    </>
  );
}
