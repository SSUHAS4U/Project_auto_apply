import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { ApplyType } from '../types';

// Shared metric-tile icon set (inline SVG, no icon dependency). Used by the Dashboard
// and Agent stat tiles so they read as one design language.
const STAT_ICONS: Record<string, ReactNode> = {
  posts: <path d="M4 5h16M4 12h16M4 19h10" />,
  target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></>,
  star: <path d="M12 3l2.9 6 6.1.9-4.5 4.3 1 6.1L12 17.8 6.5 20.3l1-6.1L3 9.9 9.1 9z" />,
  send: <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />,
  link: <path d="M9 12h6M10 8H8a4 4 0 100 8h2M14 8h2a4 4 0 010 8h-2" />,
  chat: <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  reply: <path d="M9 17l-6-5 6-5M3 12h12a6 6 0 016 6v1" />,
  alert: <><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9l-8 14A2 2 0 004 21h16a2 2 0 001.7-3.1l-8-14a2 2 0 00-3.4 0z" /></>,
};

export function StatIcon({ name, color }: { name: string; color: string }) {
  return (
    <span style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: color + '18', color, flex: 'none' }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {STAT_ICONS[name] ?? STAT_ICONS.posts}
      </svg>
    </span>
  );
}

export function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

export function ApplyBadge({ type }: { type: ApplyType }) {
  const cls = `badge badge-${type}`;
  const label = type === 'ats' ? 'ATS' : type[0].toUpperCase() + type.slice(1);
  return <span className={cls}>{label}</span>;
}

export function ScoreBar({ score }: { score?: number }) {
  const s = score ?? 0;
  const color = s >= 75 ? 'var(--green)' : s >= 50 ? 'var(--amber)' : 'var(--text-dim)';
  return (
    <div>
      <span className="score" style={{ color }}>{score ?? '—'}</span>
      <div className="score-bar"><span style={{ width: `${s}%` }} /></div>
    </div>
  );
}

/* ---- Toast ---- */
type Toast = { id: number; msg: string; kind: 'info' | 'success' | 'error' };
const ToastCtx = createContext<(msg: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  // ONE toast at a time — a new message replaces the previous one instead of stacking.
  const [toast, setToast] = useState<Toast | null>(null);
  const push = useCallback((msg: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToast({ id, msg, kind });
    setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {toast && (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          <span style={{ flex: 1, minWidth: 0 }}>{toast.msg}</span>
          <button className="toast-x" onClick={() => setToast(null)} aria-label="Dismiss">×</button>
        </div>
      )}
    </ToastCtx.Provider>
  );
}
