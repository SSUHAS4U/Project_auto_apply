import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

/** Fully-themed status dropdown. Menu is portalled to <body> (so the table overflow
 *  never clips it) and opens DOWNWARD by default, flipping up only when it truly
 *  doesn't fit below — measured from the real rendered height. */
export function StatusSelect({ value, onChange }: { value: ApplicationStatus; onChange: (s: ApplicationStatus) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = () => {
    const r = triggerRef.current!.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_W - 10));
    setPos({ left, top: r.bottom + 6 }); // default: open downward
    setOpen(true);
  };

  // After the menu renders, measure its real height and flip up only if needed.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const mh = menuRef.current.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_W - 10));
    const fitsBelow = r.bottom + 6 + mh <= window.innerHeight - 4;
    const fitsAbove = r.top - 6 - mh >= 4;
    if (!fitsBelow && fitsAbove) {
      setPos({ left, bottom: window.innerHeight - r.top + 6 }); // flip up, hugging the trigger
    } else {
      setPos({ left, top: r.bottom + 6 }); // open down (room below, or no room above either)
    }
  }, [open]);

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
