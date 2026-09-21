import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router-dom';
import './styles.css';
import { initTheme } from './lib/theme';
import { ToastProvider } from './lib/ui';

initTheme();
import { isLoggedIn, isAdminUI } from './api/client';
import { Layout } from './components/Layout';
import { DashboardPage } from './pages/DashboardPage';
import { JobsPage } from './pages/JobsPage';
import { EnginePage } from './pages/EnginePage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { ApplicationsPage } from './pages/ApplicationsPage';
import { SavedJobsPage } from './pages/SavedJobsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';
import { ComposePage } from './pages/ComposePage';
import { AssistantPage } from './pages/AssistantPage';
import { DailyPicksPage } from './pages/DailyPicksPage';
import { ScoutPage } from './pages/ScoutPage';
import { ResumesPage } from './pages/ResumesPage';
import { AdminPage } from './pages/AdminPage';
import { AuthPage } from './pages/AuthPage';
import { HomePage } from './pages/HomePage';
import { isDesktopApp } from './lib/desktop';

/**
 * The app shell for a signed-in user. Signed out, "/" is the public home page on the web (the
 * desktop app has no visitors to introduce itself to, so it goes straight to log in) and every
 * other private route goes to /login.
 */
function Guard({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  if (isLoggedIn()) return <>{children}</>;
  if (pathname === '/' && !isDesktopApp()) return <HomePage />;
  return <Navigate to="/login" replace />;
}

// Client-side hint only — the backend enforces ADMIN on every /api/admin route.
function AdminGuard({ children }: { children: React.ReactNode }) {
  return isAdminUI() ? <>{children}</> : <Navigate to="/" replace />;
}

const router = createBrowserRouter([
  { path: '/login', element: <AuthPage mode="login" /> },
  { path: '/register', element: <AuthPage mode="register" /> },
  // The home page at a stable address, whether or not you're signed in.
  { path: '/welcome', element: <HomePage /> },
  {
    path: '/',
    element: <Guard><Layout /></Guard>,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'jobs', element: <JobsPage /> },
      { path: 'auto-apply', element: <EnginePage /> },
      { path: 'auto-apply/linkedin', element: <EnginePage /> },
      { path: 'auto-apply/indeed', element: <EnginePage /> },
      { path: 'agent', element: <Navigate to="/auto-apply" replace /> },
      { path: 'connections', element: <ConnectionsPage /> },
      { path: 'daily', element: <DailyPicksPage /> },
      { path: 'scout', element: <ScoutPage /> },
      { path: 'resumes', element: <ResumesPage /> },
      { path: 'assistant', element: <AssistantPage /> },
      { path: 'compose', element: <ComposePage /> },
      { path: 'applications', element: <ApplicationsPage /> },
      { path: 'saved', element: <SavedJobsPage /> },
      { path: 'notifications', element: <NotificationsPage /> },
      { path: 'profile', element: <ProfilePage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'admin', element: <AdminGuard><AdminPage /></AdminGuard> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </React.StrictMode>,
);
