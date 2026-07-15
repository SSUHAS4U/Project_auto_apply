import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api, clearJwt, isAdminUI, setAdminUI } from '../api/client';
import { getTheme, toggleTheme, type Theme } from '../lib/theme';

const NAV = [
  { to: '/', label: 'Dashboard', ico: '▦', end: true },
  { to: '/auto-apply', label: 'Auto Apply', ico: '⚡' },
  { to: '/agent', label: 'Agent · Live', ico: '📺' },
  { to: '/jobs', label: 'Jobs', ico: '🧭' },
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
  const [theme, setTheme] = useState<Theme>(getTheme());
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
        <div className="brand-logo">H</div>
        <div>
          <div className="brand-name">HireDue</div>
          <div className="brand-sub">autonomous job agent</div>
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
        <button className="su-logout" onClick={() => setTheme(toggleTheme())}
          title={theme === 'light' ? 'Switch to dark' : 'Switch to light'} aria-label="Toggle theme">
          {theme === 'light'
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>}
        </button>
        <button className="su-logout" onClick={logout} title="Sign out">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
        </button>
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
        <div className="brand-logo sm">H</div>
        <span className="brand-name">HireDue</span>
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
