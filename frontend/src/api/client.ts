import type {
  Application, ApplicationEvent, AssistantJob, Job, Notification, Page, Profile, SavedJob,
} from '../types';

const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080';

const JWT_KEY = 'jobpilot_jwt';        // user auth (Bearer)
const ADMIN_KEY = 'jobpilot_admin_token'; // ops/cron admin token (X-Api-Token)

export function getJwt(): string { return localStorage.getItem(JWT_KEY) ?? ''; }
export function setJwt(t: string): void { localStorage.setItem(JWT_KEY, t); }
export function clearJwt(): void { localStorage.removeItem(JWT_KEY); }
export function isLoggedIn(): boolean { return !!getJwt(); }

export function getAdminToken(): string {
  return localStorage.getItem(ADMIN_KEY) ?? import.meta.env.VITE_API_TOKEN ?? '';
}
export function setAdminToken(t: string): void { localStorage.setItem(ADMIN_KEY, t); }

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(getJwt() ? { Authorization: `Bearer ${getJwt()}` } : {}),
    ...(getAdminToken() ? { 'X-Api-Token': getAdminToken() } : {}),
    ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    clearJwt();
    if (!location.pathname.startsWith('/login')) location.href = '/login';
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.message) msg = body.message;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export interface AuthResult { token: string; user: { id: string; email: string; fullName: string }; }

export interface JobFilters {
  role?: string;
  location?: string;
  minScore?: number;
  applyType?: string;
  region?: string;
  postedWithin?: number;
  since?: string;
  page?: number;
  size?: number;
}

export const api = {
  health: () => req<{ status: string }>('/api/health'),

  login: (email: string, password: string) =>
    req<AuthResult>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (email: string, password: string, fullName: string) =>
    req<AuthResult>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password, fullName }) }),
  me: () => req<{ id: string; email: string; fullName: string }>('/api/auth/me'),

  jobs: (f: JobFilters = {}) => {
    const q = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    });
    return req<Page<Job>>(`/api/jobs?${q.toString()}`);
  },
  job: (id: string) => req<Job>(`/api/jobs/${id}`),
  trackJob: (id: string) => req<Application>(`/api/jobs/${id}/track`, { method: 'POST' }),

  applications: (status?: string) =>
    req<Application[]>(`/api/applications${status ? `?status=${status}` : ''}`),
  createApplication: (body: { jobId?: string; status?: string; notes?: string }) =>
    req<Application>('/api/applications', { method: 'POST', body: JSON.stringify(body) }),
  updateApplication: (id: string, body: { status?: string; notes?: string }) =>
    req<Application>(`/api/applications/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  timeline: (id: string) => req<ApplicationEvent[]>(`/api/applications/${id}/timeline`),

  profile: () => req<Profile>('/api/profile'),
  saveProfile: (p: Profile) => req<Profile>('/api/profile', { method: 'PUT', body: JSON.stringify(p) }),
  uploadResume: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<{ filename: string; stored: boolean }>('/api/profile/resume', { method: 'POST', body: fd });
  },
  analyzeResume: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<Profile>('/api/profile/resume/analyze', { method: 'POST', body: fd });
  },

  aiStatus: () => req<{ enabled: boolean; provider: string; remainingToday: number; providers: { provider: string; configured: boolean }[] }>('/api/ai/status'),
  aiSetProvider: (provider: string) => req<{ provider: string; enabled: boolean }>('/api/ai/provider', { method: 'POST', body: JSON.stringify({ provider }) }),
  aiTest: (provider: string) => req<{ provider: string; ok: boolean; ms?: number; sample?: string; error?: string }>('/api/ai/test', { method: 'POST', body: JSON.stringify({ provider }) }),
  aiSuggest: (field: string, text: string, context?: string) =>
    req<{ suggestion: string }>('/api/ai/suggest', {
      method: 'POST', body: JSON.stringify({ field, text, context: context ?? '' }),
    }),
  assistantChat: (messages: { role: string; content: string }[]) =>
    req<{ reply: string; jobs: AssistantJob[] }>('/api/assistant/chat', {
      method: 'POST', body: JSON.stringify({ messages }),
    }),

  composeGenerate: (role: string, company: string, jobDetails: string) =>
    req<{ subject: string; coverLetter: string; coldEmail: string }>('/api/compose/generate', {
      method: 'POST', body: JSON.stringify({ role, company, jobDetails }),
    }),
  composeSend: (body: { to: string; subject?: string; coldEmail: string; coverLetter: string; attachResume: boolean }) =>
    req<{ sentTo: string; subject: string; resumeAttached: boolean }>('/api/compose/send', {
      method: 'POST', body: JSON.stringify(body),
    }),

  previewCoverLetter: (jobId: string) =>
    req<{ coverLetter: string }>('/api/cover-letter/preview', {
      method: 'POST', body: JSON.stringify({ jobId }),
    }),
  applyEmail: (jobId: string, coverLetter?: string) =>
    req<{ applicationId: string; sentTo: string; subject: string }>(`/api/apply/email/${jobId}`, {
      method: 'POST', body: JSON.stringify({ coverLetter }),
    }),

  savedJobs: () => req<SavedJob[]>('/api/saved-jobs'),
  promoteSaved: (id: string) => req<Job>(`/api/saved-jobs/${id}/promote`, { method: 'POST' }),

  notifications: (unread = false) =>
    req<{ items: Notification[]; unreadCount: number }>(`/api/notifications?unread=${unread}`),
  markNotificationRead: (id: string) =>
    req<{ ok: boolean }>(`/api/notifications/${id}/read`, { method: 'POST' }),

  ingest: () => req<{ status: string; message: string }>('/api/ingest', { method: 'POST' }),
  digest: () => req<{ count: number; sent: boolean }>('/api/digest', { method: 'POST' }),

  dailyRun: () => req<{ status: string; message: string }>('/api/daily/run', { method: 'POST' }),
  dailyPicks: () => req<{ briefing: string; generatedAt?: string; jobs: Job[] }>('/api/daily/picks'),
  opsStatus: () => req<{ running: boolean; last: string }>('/api/ops/status'),
};
