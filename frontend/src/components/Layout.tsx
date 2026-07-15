import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api, clearJwt, isAdminUI, setAdminUI } from '../api/client';

const NAV = [
  { to: '/', label: 'Jobs', ico: '🧭', end: true },
  { to: '/auto-apply', label: 'Auto Apply', ico: '⚡' },
  { to: '/agent', label: 'Agent · Live', ico: '📺' },
  { to: '/pilot', label: 'Pilot (v2)', ico: '🛰️' },
  { to: '/daily', label: 'Daily picks', ico: '☀️' },
  { to: '/scout', label: 'Scout', ico: '🔎' },
  { to: '/resumes', label: 'Resumes', ico: '📄' },
  { to: '/assistant', label: 'Assistant', ico: '🤖' },
  { to: '/compose', label: 'Compose & send', ico: '✍️' },
  { to: '/applications', label: 'Applications', ico: '📋' },
  { to: '/saved', label: 'Saved', ico: '🔖' },
  { to: '/notifications', label: 'Notifications', ico: '🔔', badge: true },
  { to: '/profile', label: 'Profile', ico: '👤' },
  { to: '/settings', label: 'Settings', ico: '⚙️' },
];
const ADMIN_NAV = { to: '/admin', label: 'Admin', ico: '🛡️' };

export function Layout() {
  const [unread, setUnread] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [email, setEmail] = useState('');
  const [admin, setAdmin] = useState(isAdminUI());
  const location = useLocation();
  const nav = useNavigate();

  // Re-check role from the server (handles grants/revokes + sessions predating roles).
  useEffect(() => {
    api.me().then((u) => { setEmail(u.email); setAdmin(!!u.isAdmin); setAdminUI(!!u.isAdmin); }).catch(() => {});
  }, []);
  const logout = () => { clearJwt(); nav('/login'); };

  const navItems = admin ? [...NAV, ADMIN_NAV] : NAV;

  useEffect(() => {
    let active = true;
    const poll = () =>
      api.notifications(true).then((r) => active && setUnread(r.unreadCount)).catch(() => {});
    poll();
    const t = setInterval(poll, 30000);
    return () => { active = false; clearInterval(t); };
  }, []);

  // Close the mobile drawer on navigation.
  useEffect(() => { setDrawer(false); }, [location.pathname]);

  const sidebar = (
    <aside className={`sidebar ${drawer ? 'open' : ''}`}>
      <div className="brand">
        <div className="brand-logo">J</div>
        <div>
          <div className="brand-name">JobPilot</div>
          <div className="brand-sub">personal job copilot</div>
        </div>
      </div>
      {navItems.map((n) => (
        <NavLink key={n.to} to={n.to} end={(n as { end?: boolean }).end}
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="ico">{n.ico}</span>
          <span>{n.label}</span>
          {(n as { badge?: boolean }).badge && unread > 0 && <span className="nav-badge">{unread}</span>}
        </NavLink>
      ))}
      <div className="sidebar-user">
        <div className="su-avatar">{(email[0] || 'U').toUpperCase()}</div>
        <div className="su-email" title={email}>{email || 'account'}</div>
        <button className="su-logout" onClick={logout} title="Sign out">⎋</button>
      </div>
    </aside>
  );

  return (
    <div className="app">
      {/* Mobile top bar */}
      <header className="topbar">
        <button className="hamburger" aria-label="Menu" onClick={() => setDrawer((d) => !d)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
        </button>
        <div className="brand-logo sm">J</div>
        <span className="brand-name">JobPilot</span>
        {unread > 0 && <span className="nav-badge" style={{ marginLeft: 'auto' }}>{unread}</span>}
      </header>

      {sidebar}
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
