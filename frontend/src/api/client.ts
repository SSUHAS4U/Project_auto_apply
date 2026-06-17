import type {
  Application, ApplicationEvent, Job, Notification, Page, Profile, SavedJob,
} from '../types';

const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080';

const TOKEN_KEY = 'jobpilot_api_token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? import.meta.env.VITE_API_TOKEN ?? '';
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'X-Api-Token': getToken(),
    ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
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

export interface JobFilters {
  role?: string;
  location?: string;
  minScore?: number;
  applyType?: string;
  since?: string;
  page?: number;
  size?: number;
}

export const api = {
  health: () => req<{ status: string }>('/api/health'),

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

  ingest: () => req<{ fetched: number; inserted: number; updated: number }>('/api/ingest', { method: 'POST' }),
  digest: () => req<{ count: number; sent: boolean }>('/api/digest', { method: 'POST' }),
};
