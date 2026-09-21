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
