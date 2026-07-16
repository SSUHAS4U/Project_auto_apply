import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AgentStatus, PortalConnection } from '../types';
import { fmtDate, useToast } from '../lib/ui';
import { DownloadDesktop } from '../components/DownloadDesktop';
import { Icon } from '../components/Icon';

/**
 * Connections — the "Connect" UX for the job portals. For LinkedIn/Naukri/Indeed the
 * connection is your logged-in browser session on your PC (like VS Code ↔ GitHub, the
 * sign-in happens in a real browser and the session stays on your machine — the server
 * never sees your password or cookies). Click Connect → the worker opens that portal's
 * login → you sign in once → it turns Active.
 */

const PORTALS: Record<string, { name: string; color: string; letter: string }> = {
  linkedin: { name: 'LinkedIn', color: '#0A66C2', letter: 'in' },
  naukri: { name: 'Naukri', color: '#6D28D9', letter: 'n' },
  indeed: { name: 'Indeed', color: '#2557A7', letter: 'i' },
};

const STATUS: Record<string, { label: string; color: string }> = {
  connected: { label: 'Active', color: '#16a34a' },
  connecting: { label: 'Waiting for sign-in…', color: '#d97706' },
  disconnected: { label: 'Not connected', color: '#838b98' },
};

export function ConnectionsPage() {
  const toast = useToast();
  const nav = useNavigate();
  const [conns, setConns] = useState<PortalConnection[]>([]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    api.agentConnections().then(setConns).catch(() => {});
    api.agentStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000); // live: flips to Active seconds after you sign in
    return () => clearInterval(t);
  }, [load]);

  // "online" = JobPilot Desktop is actually running right now (heartbeat), not just that a
  // connect code was once generated. This is what gates the Connect buttons.
  const online = status?.workerOnline ?? false;

  const connect = async (portal: string) => {
    if (!online) { toast('Open JobPilot Desktop first — it isn’t running.', 'error'); return; }
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Connections</h1>
          <div className="page-sub">
            Connect the job portals your agent applies through. Sign-in happens in your own browser and
            stays on your machine — this server never sees your password or cookies.
          </div>
        </div>
      </div>

      {/* Live status of the desktop app — this is what makes Connect work. */}
      {status && (online ? (
        <div className="card card-pad" style={{ marginBottom: 14, borderColor: '#16a34a', fontSize: 13.5 }}>
          <span style={{ color: '#16a34a', fontWeight: 700 }}>● JobPilot Desktop is running.</span>{' '}
          <span className="faint">Click Connect on a portal below — its login opens in the app.</span>
        </div>
      ) : (
        <div className="card card-pad" style={{ marginBottom: 14, borderColor: '#d97706' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            <span style={{ color: '#d97706' }}>○</span> JobPilot Desktop isn’t running
          </div>
          <p className="faint" style={{ fontSize: 13, margin: '6px 0 10px', lineHeight: 1.6 }}>
            Connecting needs the desktop app open — it's the piece that opens a real browser to apply for you
            (the same way VS Code is an app on your computer). Download it, open it, and paste the connect code
            once. Then the Connect buttons below light up.
          </p>
          <DownloadDesktop compact />
          <div className="row" style={{ gap: 12, marginTop: 8 }}>
            <a onClick={() => nav('/agent')} style={{ cursor: 'pointer', color: 'var(--accent)', fontSize: 12.5 }}>
              Get the connect code &amp; full setup →
            </a>
          </div>
        </div>
      ))}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
        {conns.map((c) => {
          const p = PORTALS[c.portal];
          const s = STATUS[c.status] ?? STATUS.disconnected;
          if (!p) return null;
          return (
            <div key={c.portal} className="card card-pad">
              <div className="row" style={{ gap: 12, alignItems: 'center' }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 11, background: p.color, color: '#fff',
                  display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 17, flex: 'none',
                }}>{p.letter}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{p.name}</div>
                  <div className="row" style={{ gap: 6, alignItems: 'center', fontSize: 13 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, display: 'inline-block' }} />
                    <span style={{ color: s.color, fontWeight: 600 }}>{s.label}</span>
                  </div>
                </div>
              </div>
              <div className="row" style={{ marginTop: 14, gap: 8 }}>
                {c.status === 'connected' ? (
                  <button className="btn btn-sm" style={{ flex: 1 }} onClick={() => disconnect(c.portal)} disabled={busy === c.portal}>
                    Disconnect {p.name}
                  </button>
                ) : (
                  <button className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={() => connect(c.portal)}
                    disabled={busy === c.portal || c.status === 'connecting' || !online}
                    title={online ? '' : 'Open JobPilot Desktop first'}>
                    {busy === c.portal || c.status === 'connecting' ? <span className="spinner" /> : <Icon name="link" size={14} />}{' '}
                    {c.status === 'connecting' ? 'Waiting for sign-in…' : `Connect ${p.name}`}
                  </button>
                )}
              </div>
              {/* surface the reason a connect stalled (e.g. app wasn't running) */}
              {c.detail && c.status !== 'connected' && (
                <div style={{ fontSize: 12, marginTop: 8, color: c.status === 'connecting' ? 'var(--text-dim)' : '#d97706' }}>
                  {c.detail}
                </div>
              )}
              {c.updatedAt && <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>Updated {fmtDate(c.updatedAt)}</div>}
            </div>
          );
        })}

        {/* Email — configured in Settings (Brevo/SMTP), used for email-type applications */}
        <div className="card card-pad">
          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
            <div style={{ width: 44, height: 44, borderRadius: 11, background: '#DB4437', color: '#fff', display: 'grid', placeItems: 'center', flex: 'none' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Email</div>
              <div className="faint" style={{ fontSize: 13 }}>For email-type applications &amp; outreach</div>
            </div>
          </div>
          <button className="btn btn-sm" style={{ marginTop: 14, width: '100%' }} onClick={() => nav('/settings')}>Manage in Settings</button>
        </div>
      </div>

      <div className="card card-pad" style={{ marginTop: 16, fontSize: 13 }}>
        <b>What happens when you click Connect</b>
        <p className="faint" style={{ margin: '6px 0 0', lineHeight: 1.7 }}>
          A browser opens on that portal's login page. You sign in once — the login is saved on your computer
          (never on our servers), and the card turns <b style={{ color: '#16a34a' }}>Active</b> within seconds.
          From then on the agent can search and apply there for you. It's the same idea as signing into GitHub
          from VS Code: the app on your machine handles the sign-in; we only ever see “connected: yes”.
        </p>
      </div>
    </>
  );
}
