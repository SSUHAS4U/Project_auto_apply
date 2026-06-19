import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import './styles.css';
import { ToastProvider } from './lib/ui';
import { isLoggedIn } from './api/client';
import { Layout } from './components/Layout';
import { JobsPage } from './pages/JobsPage';
import { ApplicationsPage } from './pages/ApplicationsPage';
import { SavedJobsPage } from './pages/SavedJobsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { ProfilePage } from './pages/ProfilePage';
import { SettingsPage } from './pages/SettingsPage';
import { ComposePage } from './pages/ComposePage';
import { AssistantPage } from './pages/AssistantPage';
import { DailyPicksPage } from './pages/DailyPicksPage';
import { AuthPage } from './pages/AuthPage';

function Guard({ children }: { children: React.ReactNode }) {
  return isLoggedIn() ? <>{children}</> : <Navigate to="/login" replace />;
}

const router = createBrowserRouter([
  { path: '/login', element: <AuthPage mode="login" /> },
  { path: '/register', element: <AuthPage mode="register" /> },
  {
    path: '/',
    element: <Guard><Layout /></Guard>,
    children: [
      { index: true, element: <JobsPage /> },
      { path: 'daily', element: <DailyPicksPage /> },
      { path: 'assistant', element: <AssistantPage /> },
      { path: 'compose', element: <ComposePage /> },
      { path: 'applications', element: <ApplicationsPage /> },
      { path: 'saved', element: <SavedJobsPage /> },
      { path: 'notifications', element: <NotificationsPage /> },
      { path: 'profile', element: <ProfilePage /> },
      { path: 'settings', element: <SettingsPage /> },
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
