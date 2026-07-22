import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api, clearJwt, isAdminUI, setAdminUI } from '../api/client';
import { getTheme, toggleTheme, type Theme } from '../lib/theme';
import { Icon, Logo } from './Icon';
import { AssistantWidget } from './AssistantWidget';

/**
 * Sidebar navigation, grouped: top-level destinations with collapsible children so the
 * menu stays short. Notifications live as a bell in the user row (with unread badge);
 * the Assistant is a floating chat widget, not a nav destination.
 */
type NavChild = { to: string; label: string; ico: string; admin?: boolean; end?: boolean };
type NavEntry = { label: string; ico: string; to?: string; end?: boolean; children?: NavChild[] };

const NAV: NavEntry[] = [
  { label: 'Dashboard', ico: 'dashboard', to: '/', end: true },
  {
    label: 'Auto Apply', ico: 'bolt',
    children: [
      { to: '/auto-apply', label: 'Automation', ico: 'live', end: true },
      { to: '/connections', label: 'Connections', ico: 'link' },
      { to: '/auto-apply/linkedin', label: 'LinkedIn', ico: 'linkedin' },
      { to: '/auto-apply/indeed', label: 'Indeed', ico: 'indeed' },
      { to: '/auto-apply/sourcing', label: 'Sourcing', ico: 'search' },
      { to: '/auto-apply/interview', label: 'Interview', ico: 'target' },
      { to: '/auto-apply/upskill', label: 'Upskill', ico: 'chart' },
    ],
  },
  {
    label: 'Jobs', ico: 'compass',
    children: [
      { to: '/jobs', label: 'Job board', ico: 'compass' },
      { to: '/daily', label: 'Daily picks', ico: 'sun' },
      { to: '/scout', label: 'Scout', ico: 'search' },
    ],
  },
  {
    label: 'Documents', ico: 'file',
    children: [
      { to: '/resumes', label: 'Resumes', ico: 'file' },
      { to: '/compose', label: 'Compose & send', ico: 'pen' },
    ],
  },
  {
    label: 'Applications', ico: 'clipboard',
    children: [
      { to: '/applications', label: 'Tracker', ico: 'clipboard' },
      { to: '/saved', label: 'Saved jobs', ico: 'bookmark' },
    ],
  },
  {
    label: 'Settings', ico: 'gear',
    children: [
      { to: '/settings', label: 'Preferences', ico: 'gear' },
      { to: '/profile', label: 'Profile', ico: 'user' },
      { to: '/admin', label: 'Admin', ico: 'shield', admin: true },
    ],
  },
];

export function Layout() {
  const [unread, setUnread] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [email, setEmail] = useState('');
  const [admin, setAdmin] = useState(isAdminUI());
  const [theme, setTheme] = useState<Theme>(getTheme());
  const location = useLocation();
  const nav = useNavigate();

  // Which group is expanded — default to the group owning the current route.
  const groupOf = (path: string) =>
    NAV.find((g) => g.children?.some((c) => path.startsWith(c.to)))?.label ?? '';
  const [open, setOpen] = useState<string>(groupOf(location.pathname));

  // Re-check role from the server (handles grants/revokes + sessions predating roles).
  useEffect(() => {
    api.me().then((u) => { setEmail(u.email); setAdmin(!!u.isAdmin); setAdminUI(!!u.isAdmin); }).catch(() => {});
  }, []);
  const logout = () => { clearJwt(); nav('/login'); };

  useEffect(() => {
    let active = true;
    const poll = () =>
      api.notifications(true).then((r) => active && setUnread(r.unreadCount)).catch(() => {});
    poll();
    const t = setInterval(poll, 30000);
    return () => { active = false; clearInterval(t); };
  }, []);

  // Close the mobile drawer on navigation; keep the owning group expanded.
  useEffect(() => { setDrawer(false); setOpen(groupOf(location.pathname)); }, [location.pathname]);

  const sidebar = (
    <aside className={`sidebar ${drawer ? 'open' : ''}`}>
      <div className="brand">
        <Logo />
        <div>
          <div className="brand-name">JobPilot</div>
          <div className="brand-sub">autonomous job agent</div>
        </div>
      </div>

      {NAV.map((g) => g.children ? (
        <div key={g.label} className="nav-group">
          <button
            className={`nav-item nav-parent ${groupOf(location.pathname) === g.label ? 'active' : ''}`}
            onClick={() => setOpen((o) => (o === g.label ? '' : g.label))}
            aria-expanded={open === g.label}>
            <span className="ico"><Icon name={g.ico} size={18} /></span>
            <span>{g.label}</span>
            <span className={`nav-caret ${open === g.label ? 'open' : ''}`}><Icon name="chevron" size={14} /></span>
          </button>
          {open === g.label && (
            <div className="nav-children">
              {g.children.filter((c) => !c.admin || admin).map((c) => (
                <NavLink key={c.to} to={c.to} end={c.end}
                  className={({ isActive }) => `nav-item nav-child ${isActive ? 'active' : ''}`}>
                  <span className="ico"><Icon name={c.ico} size={15} /></span>
                  <span>{c.label}</span>
                </NavLink>
              ))}
            </div>
          )}
        </div>
      ) : (
        <NavLink key={g.to} to={g.to!} end={g.end}
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <span className="ico"><Icon name={g.ico} size={18} /></span>
          <span>{g.label}</span>
        </NavLink>
      ))}

      <div className="sidebar-user su-col">
        <div className="su-id">
          <div className="su-avatar">{(email[0] || 'U').toUpperCase()}</div>
          <div className="su-email" title={email}>{email || 'account'}</div>
        </div>
        <div className="su-actions">
          <button className="su-act su-bell" onClick={() => nav('/notifications')}
            title="Notifications" aria-label="Notifications">
            <Icon name="bell" size={16} />
            {unread > 0 && <span className="su-bell-badge">{unread > 99 ? '99+' : unread}</span>}
          </button>
          <button className="su-act" onClick={() => setTheme(toggleTheme())}
            title={theme === 'light' ? 'Switch to dark' : 'Switch to light'} aria-label="Toggle theme">
            {theme === 'light'
              ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
              : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>}
          </button>
          <button className="su-act" onClick={logout} title="Sign out" aria-label="Sign out">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
          </button>
        </div>
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
        <Logo size={26} />
        <span className="brand-name">JobPilot</span>
        <button className="su-logout su-bell" style={{ marginLeft: 'auto' }} onClick={() => nav('/notifications')}
          title="Notifications" aria-label="Notifications">
          <Icon name="bell" size={17} />
          {unread > 0 && <span className="su-bell-badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
      </header>

      {sidebar}
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}

      <main className="main">
        <div className="page">
          <Outlet />
        </div>
      </main>

      <AssistantWidget />
    </div>
  );
}
