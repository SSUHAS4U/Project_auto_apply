import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { ApplyType } from '../types';

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
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((msg: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>
      ))}
    </ToastCtx.Provider>
  );
}
