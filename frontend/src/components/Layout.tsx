import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../api/client';

const NAV = [
  { to: '/', label: 'Jobs', ico: '🧭', end: true },
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

  useEffect(() => {
    let active = true;
    const poll = () =>
      api.notifications(true).then((r) => active && setUnread(r.unreadCount)).catch(() => {});
    poll();
    const t = setInterval(poll, 30000);
    return () => { active = false; clearInterval(t); };
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">J</div>
          <div>
            <div className="brand-name">JobPilot</div>
            <div className="brand-sub">personal job copilot</div>
          </div>
        </div>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <span className="ico">{n.ico}</span>
            <span>{n.label}</span>
            {n.badge && unread > 0 && <span className="nav-badge">{unread}</span>}
          </NavLink>
        ))}
        <div className="sidebar-foot">v0.1 · single-user</div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
