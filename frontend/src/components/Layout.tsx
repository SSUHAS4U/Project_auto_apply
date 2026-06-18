import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../api/client';

const NAV = [
  { to: '/', label: 'Jobs', ico: '🧭', end: true },
  { to: '/daily', label: 'Daily picks', ico: '☀️' },
  { to: '/assistant', label: 'Assistant', ico: '🤖' },
  { to: '/compose', label: 'Compose & send', ico: '✍️' },
  { to: '/applications', label: 'Applications', ico: '📋' },
  { to: '/saved', label: 'Saved', ico: '🔖' },
  { to: '/notifications', label: 'Notifications', ico: '🔔', badge: true },
  { to: '/profile', label: 'Profile', ico: '👤' },
  { to: '/settings', label: 'Settings', ico: '⚙️' },
];

export function Layout() {
  const [unread, setUnread] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();

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
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end}
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="ico">{n.ico}</span>
          <span>{n.label}</span>
          {n.badge && unread > 0 && <span className="nav-badge">{unread}</span>}
        </NavLink>
      ))}
      <div className="sidebar-foot">v0.1 · single-user</div>
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
