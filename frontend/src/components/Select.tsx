import { useEffect, useRef, useState } from 'react';
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
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
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
      {open && (
        <div className="tsel-menu" role="listbox">
          {options.map((o) => (
            <button key={o.value} type="button" role="option" aria-selected={o.value === value}
              className={`tsel-opt ${o.value === value ? 'active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}>
              <span className="tsel-check">{o.value === value && <Icon name="check" size={13} />}</span>
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
