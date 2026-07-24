import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export interface SelectOption { value: string; label: string }

/**
 * A fully themed dropdown. Native <select> option popups are OS-rendered and can't be styled
 * (only their color-scheme), so anywhere the menu appearance matters we use this instead — a
 * div-based menu that matches the app: rounded, elevated, dark/light-aware, with a check on the
 * current option. Keeps the same value/onChange contract as a <select>.
 */
export function Select({ value, options, onChange, ariaLabel, style, className }: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  ariaLabel?: string;
  style?: React.CSSProperties;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; drop: 'down' | 'up' }>(
    { top: 0, left: 0, width: 0, drop: 'down' });

  /**
   * The menu is rendered into <body> with fixed positioning instead of being absolutely
   * placed inside the control. Any scrolling ancestor clips an absolute child — the Filters
   * dialog is `overflow:auto`, so the options were being cut off mid-list and no z-index
   * could rescue them. Portalling escapes the clip entirely; the trade is that we position
   * it ourselves, which also lets it flip up when there's no room below.
   */
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const place = () => {
      const r = ref.current!.getBoundingClientRect();
      const vh = document.documentElement.clientHeight;
      const need = Math.min(options.length * 38 + 12, 260);
      const below = vh - r.bottom - 8;
      const drop: 'down' | 'up' = below < need && r.top > below ? 'up' : 'down';
      setPos({
        top: drop === 'down' ? r.bottom + 6 : Math.max(6, r.top - need - 6),
        left: r.left, width: r.width, drop,
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, options.length]);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      // The menu is portalled to <body>, so it is NOT inside ref — check it separately or
      // every option click would close the menu before it registered.
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className={`tsel ${className ?? ''}`} ref={ref} style={style}>
      <button type="button" className={`tsel-btn ${open ? 'open' : ''}`} aria-label={ariaLabel}
        aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tsel-val">{current?.label ?? value}</span>
        <Icon name="chevron" size={14} className={`tsel-caret ${open ? 'open' : ''}`} />
      </button>
      {open && createPortal(
        <div className="tsel-menu" role="listbox" ref={menuRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, minWidth: pos.width }}>
          {options.map((o) => (
            <button key={o.value} type="button" role="option" aria-selected={o.value === value}
              className={`tsel-opt ${o.value === value ? 'active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}>
              <span className="tsel-check">{o.value === value && <Icon name="check" size={13} />}</span>
              <span>{o.label}</span>
            </button>
          ))}
        </div>, document.body)}
    </div>
  );
}
