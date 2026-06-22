import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

const MENU_W = 180;
const MENU_H = 280; // ~6 rows + padding

/** Fully-themed status dropdown. The menu is portalled to <body> with fixed
 *  positioning so it floats above the table instead of being clipped by its overflow. */
export function StatusSelect({ value, onChange }: { value: ApplicationStatus; onChange: (s: ApplicationStatus) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = () => {
    const r = triggerRef.current!.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_W - 10));
    // If there isn't room below, open UPWARD anchored by the menu's BOTTOM edge (just above
    // the trigger) so it hugs the clicked row regardless of how tall the menu actually is.
    if (spaceBelow < MENU_H + 12 && r.top > spaceBelow) {
      setPos({ left, bottom: Math.max(8, window.innerHeight - r.top + 6) });
    } else {
      setPos({ left, top: r.bottom + 6 });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!triggerRef.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const dismiss = () => setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  const pick = (s: ApplicationStatus, e: React.MouseEvent) => {
    e.stopPropagation(); setOpen(false);
    if (s !== value) onChange(s);
  };

  return (
    <div className="status-select" onClick={(e) => e.stopPropagation()}>
      <button ref={triggerRef} type="button" className="status-trigger"
        onClick={() => (open ? setOpen(false) : openMenu())} aria-haspopup="listbox" aria-expanded={open}>
        <span className="status-dot" style={{ background: DOT[value], color: DOT[value] }} />
        <span className="status-label">{value}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className="status-menu" role="listbox"
          style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, width: MENU_W }}>
          {ALL.map((s) => (
            <button key={s} type="button" role="option" aria-selected={s === value}
              className={`status-opt ${s === value ? 'sel' : ''}`} onClick={(e) => pick(s, e)}>
              <span className="status-dot" style={{ background: DOT[s], color: DOT[s] }} />
              <span className="grow">{s}</span>
              {s === value && <span className="status-check">✓</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
