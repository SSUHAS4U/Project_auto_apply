import type {
  Application, ApplicationEvent, AssistantJob, Job, Notification, Page,
  PilotConfig, PilotCycle, PilotJobDetail, PilotJobSummary, PilotStatus, Profile, SavedJob,
} from '../types';

const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080';

const JWT_KEY = 'jobpilot_jwt';        // user auth (Bearer)
const ADMIN_KEY = 'jobpilot_admin_token'; // ops/cron admin token (X-Api-Token)

const ROLE_KEY = 'jobpilot_is_admin';   // cached UI hint only — server re-checks every admin request

export function getJwt(): string { return localStorage.getItem(JWT_KEY) ?? ''; }
export function setJwt(t: string): void { localStorage.setItem(JWT_KEY, t); }
export function clearJwt(): void { localStorage.removeItem(JWT_KEY); localStorage.removeItem(ROLE_KEY); }
export function isLoggedIn(): boolean { return !!getJwt(); }

/** UI convenience only — the backend authoritatively enforces ADMIN on every admin route. */
export function isAdminUI(): boolean { return localStorage.getItem(ROLE_KEY) === '1'; }
export function setAdminUI(v: boolean): void { localStorage.setItem(ROLE_KEY, v ? '1' : '0'); }

// NOTE: never fall back to a build-time token — that would bake the machine secret
// into the public JS bundle. Ops/admin actions are authorized by the ADMIN-role JWT.
// This only returns a token the user explicitly pasted in Settings (kept local).
export function getAdminToken(): string {
  return localStorage.getItem(ADMIN_KEY) ?? '';
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

export interface AuthResult { token: string; user: { id: string; email: string; fullName: string; role?: string; isAdmin?: boolean }; }

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
  me: () => req<{ id: string; email: string; fullName: string; role: string; isAdmin: boolean }>('/api/auth/me'),

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
    req<{ sentTo: string; subject: string; resumeAttached: boolean; coverLetterAttached: boolean }>('/api/compose/send', {
      method: 'POST', body: JSON.stringify(body),
    }),
  composeRefine: (body: { coldEmail: string; coverLetter: string; instruction: string }) =>
    req<{ coldEmail: string; coverLetter: string }>('/api/compose/refine', {
      method: 'POST', body: JSON.stringify(body),
    }),
  composeCoverPdf: async (coverLetter: string): Promise<Blob> => {
    const res = await fetch(`${BASE}/api/compose/cover-pdf`, {
      method: 'POST',
      headers: { ...(getJwt() ? { Authorization: `Bearer ${getJwt()}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({ coverLetter }),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.blob();
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
  updateSaved: (id: string, body: { title?: string; company?: string; location?: string; url?: string }) =>
    req<SavedJob>(`/api/saved-jobs/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteSaved: (id: string) => req<{ deleted: boolean }>(`/api/saved-jobs/${id}`, { method: 'DELETE' }),

  notifications: (unread = false) =>
    req<{ items: Notification[]; unreadCount: number }>(`/api/notifications?unread=${unread}`),
  markNotificationRead: (id: string) =>
    req<{ ok: boolean }>(`/api/notifications/${id}/read`, { method: 'POST' }),

  ingest: () => req<{ status: string; message: string }>('/api/ingest', { method: 'POST' }),
  wipeJobs: () => req<{ deleted: number }>('/api/maintenance/wipe-jobs', { method: 'POST' }),
  digest: () => req<{ count: number; sent: boolean }>('/api/digest', { method: 'POST' }),

  dailyRun: () => req<{ status: string; message: string }>('/api/daily/run', { method: 'POST' }),
  dailyPicks: () => req<{ briefing: string; generatedAt?: string; jobs: Job[] }>('/api/daily/picks'),
  opsStatus: () => req<{ running: boolean; last: string }>('/api/ops/status'),

  // Ingest metrics — summary is for everyone (top of board); detailed is admin-only.
  ingestSummary: () => req<IngestSummary>('/api/metrics/ingest'),
  ingestMetrics: () => req<IngestMetrics>('/api/ops/ingest'),
  testEmail: (to?: string) => req<{ ok: boolean; sentTo?: string; error?: string }>('/api/ops/test-email', { method: 'POST', body: JSON.stringify({ to: to ?? '' }) }),

  // Document vault (encrypted at rest; download needs the account password).
  docList: () => req<DocItem[]>('/api/documents'),
  docUpload: (file: File, name: string, type: string) => {
    const fd = new FormData();
    fd.append('file', file); fd.append('name', name); fd.append('type', type);
    return req<DocItem>('/api/documents', { method: 'POST', body: fd });
  },
  docDelete: (id: string) => req<{ deleted: boolean }>(`/api/documents/${id}`, { method: 'DELETE' }),
  docDownload: async (id: string, password: string): Promise<Blob> => {
    const res = await fetch(`${BASE}/api/documents/${id}/download`, {
      method: 'POST',
      headers: { ...(getJwt() ? { Authorization: `Bearer ${getJwt()}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      let msg = res.status === 401 ? 'Incorrect password' : `${res.status}`;
      try { const b = await res.json(); if (b?.message) msg = b.message; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return res.blob();
  },

  // Saved autofill answers (Q&A bank) — the extension writes these; manage them here.
  qaList: () => req<QaPair[]>('/api/assist/qa'),
  qaUpdate: (id: string, body: { question: string; answer: string }) =>
    req<QaPair>(`/api/assist/qa/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  qaDelete: (id: string) => req<{ deleted: boolean }>(`/api/assist/qa/${id}`, { method: 'DELETE' }),

  // Pilot (Auto Apply): the observed evaluate→draft→review→verify→apply pipeline.
  pilotStatus: () => req<PilotStatus>('/api/pilot/status'),
  pilotToggle: (enabled: boolean) =>
    req<{ enabled: boolean }>('/api/pilot/toggle', { method: 'POST', body: JSON.stringify({ enabled }) }),
  pilotConfig: (config: PilotConfig) =>
    req<PilotConfig>('/api/pilot/config', { method: 'PUT', body: JSON.stringify(config) }),
  pilotRun: () => req<{ status: string; message?: string }>('/api/pilot/run', { method: 'POST' }),
  pilotCycles: (limit = 20) => req<PilotCycle[]>(`/api/pilot/cycles?limit=${limit}`),
  pilotCycleJobs: (cycleId: string) => req<PilotJobSummary[]>(`/api/pilot/cycles/${cycleId}/jobs`),
  pilotJobs: (stage?: string, limit = 100) =>
    req<PilotJobSummary[]>(`/api/pilot/jobs?limit=${limit}${stage ? `&stage=${stage}` : ''}`),
  pilotJob: (id: string) => req<PilotJobDetail>(`/api/pilot/jobs/${id}`),
  pilotQueue: (limit = 100) => req<PilotJobSummary[]>(`/api/pilot/queue?limit=${limit}`),
  pilotQueueStatus: (id: string, status: 'opened' | 'applied' | 'dismissed' | 'pending') =>
    req<{ id: string; queueStatus: string }>(`/api/pilot/queue/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  pilotPdf: async (id: string, kind: 'cv' | 'cover'): Promise<Blob> => {
    const res = await fetch(`${BASE}/api/pilot/jobs/${id}/${kind}.pdf`, {
      headers: { ...(getJwt() ? { Authorization: `Bearer ${getJwt()}` } : {}) },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.blob();
  },

  // Job Scout — automated resume-keyword search across LinkedIn/Naukri/Indeed/Google.
  scoutJobs: (limit = 200) => req<ScoutedJob[]>(`/api/scout/jobs?limit=${limit}`),
  scoutRun: () => req<ScoutRunResult>('/api/scout/run', { method: 'POST' }),
  scoutDelete: (id: string) => req<{ deleted: boolean }>(`/api/scout/jobs/${id}`, { method: 'DELETE' }),

  // LaTeX resume builder (Overleaf-style).
  resumeList: () => req<ResumeDoc[]>('/api/resumes'),
  resumeGet: (id: string) => req<ResumeDoc>(`/api/resumes/${id}`),
  resumeCreate: (body: { name?: string; latex?: string; fromId?: string; blank?: string }) =>
    req<ResumeDoc>('/api/resumes', { method: 'POST', body: JSON.stringify(body) }),
  resumeUpdate: (id: string, body: { name?: string; latex?: string }) =>
    req<ResumeDoc>(`/api/resumes/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  resumeDelete: (id: string) => req<{ deleted: boolean }>(`/api/resumes/${id}`, { method: 'DELETE' }),
  resumeSetBase: (id: string) => req<ResumeDoc>(`/api/resumes/${id}/base`, { method: 'POST' }),
  resumeTailor: (body: { name?: string; jobUrl?: string; jdText: string }) =>
    req<ResumeDoc>('/api/resumes/tailor', { method: 'POST', body: JSON.stringify(body) }),
  resumeCompile: async (id: string): Promise<Blob> => {
    const res = await fetch(`${BASE}/api/resumes/${id}/compile`, {
      method: 'POST',
      headers: { ...(getJwt() ? { Authorization: `Bearer ${getJwt()}` } : {}) },
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const b = await res.json(); if (b?.message) msg = b.message; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return res.blob();
  },
  resumePdf: async (id: string): Promise<Blob> => {
    const res = await fetch(`${BASE}/api/resumes/${id}/pdf`, {
      headers: { ...(getJwt() ? { Authorization: `Bearer ${getJwt()}` } : {}) },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.blob();
  },

  // Admin (server enforces ADMIN role on these routes).
  adminUsers: (q = '') => req<AdminUser[]>(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  adminUser: (id: string) => req<AdminUserDetail>(`/api/admin/users/${id}`),
  adminDeleteUser: (id: string) => req<{ deleted: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
  adminSetRole: (id: string, role: 'ADMIN' | 'USER') =>
    req<AdminUser>(`/api/admin/users/${id}/role`, { method: 'POST', body: JSON.stringify({ role }) }),

  adminSecrets: () => req<SecretStatus[]>('/api/admin/secrets'),
  adminSetSecret: (name: string, value: string) =>
    req<{ saved: boolean }>(`/api/admin/secrets/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  adminDeleteSecret: (name: string) =>
    req<{ deleted: boolean }>(`/api/admin/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};

export type SecretStatus = {
  name: string; label: string; group: string;
  configured: boolean; source: 'saved' | 'env' | 'none'; updatedAt: string | null;
};

export type LastRun = { finishedAt: string; inserted: number; updated: number; fetched: number; totalJobs: number; durationSec: number };
export type IngestSummary = { running: boolean; totalJobs: number; lastRun: LastRun | null; nextRun?: string | null };
export type IngestMetrics = {
  status: string; running: boolean; startedAt?: string; finishedAt?: string;
  fetched: number; inserted: number; updated: number; sources: number; sourcesDone: number;
  log: string[]; boards: { source: string; count: number }[]; totalJobs: number;
  memory: { usedMb: number; committedMb: number; maxMb: number; usedPct: number };
  lastRun: LastRun | null;
  nextRun?: string | null;
};

export type DocItem = { id: string; name: string; type: string; filename: string; contentType?: string; sizeBytes?: number; createdAt?: string };

export type ScoutedJob = {
  id: string; title: string; company?: string; location?: string; url: string;
  sourceSite?: string; snippet?: string; emails?: string; phones?: string;
  matchedKeywords?: string; matchScore?: number; postedHint?: string;
  fetchedAt?: string; createdAt?: string;
};
export type ScoutRunResult = {
  keywords: string[]; found: number; kept: number; purged: number; total: number;
  bySite?: Record<string, number>; channels?: Record<string, string>;
};

export type ResumeDoc = {
  id: string; name: string; latex: string; base: boolean; hasPdf: boolean;
  jobUrl?: string; tailorNotes?: string; createdAt?: string; updatedAt?: string;
};

export type QaPair = { id: string; question: string; answer: string; source: string; updatedAt?: string };
export type AdminUser = {
  id: string; email: string; fullName: string; role: string; isAdmin: boolean; owner?: boolean;
  createdAt?: string; applications: number; savedJobs: number;
};
export type AdminUserDetail = AdminUser & {
  phone?: string; location?: string; headline?: string; currentTitle?: string;
  currentCompany?: string; yearsExperience?: string; skills?: string[];
  summary?: string; resumeFilename?: string;
};
