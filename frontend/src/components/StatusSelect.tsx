import { useEffect, useRef, useState } from 'react';
import type { ApplicationStatus } from '../types';

const ALL: ApplicationStatus[] = ['interested', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn'];
const DOT: Record<ApplicationStatus, string> = {
  interested: 'var(--blue)',
  applied: 'var(--accent-hi)',
  interviewing: 'var(--amber)',
  offer: 'var(--green)',
  rejected: 'var(--red)',
  withdrawn: 'var(--text-faint)',
};

/** Fully-themed status dropdown (the native <select> list can't be dark-styled). */
export function StatusSelect({ value, onChange }: { value: ApplicationStatus; onChange: (s: ApplicationStatus) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const pick = (s: ApplicationStatus, e: React.MouseEvent) => {
    e.stopPropagation(); setOpen(false);
    if (s !== value) onChange(s);
  };

  return (
    <div className="status-select" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="status-trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="status-dot" style={{ background: DOT[value], color: DOT[value] }} />
        <span className="status-label">{value}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="status-menu" role="listbox">
          {ALL.map((s) => (
            <button key={s} type="button" role="option" aria-selected={s === value}
              className={`status-opt ${s === value ? 'sel' : ''}`} onClick={(e) => pick(s, e)}>
              <span className="status-dot" style={{ background: DOT[s], color: DOT[s] }} />
              <span className="grow">{s}</span>
              {s === value && <span className="status-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
