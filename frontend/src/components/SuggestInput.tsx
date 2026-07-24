import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A single-value text field with themed type-ahead.
 *
 * The native <datalist> this replaces is drawn by the browser: it can't be styled, looks
 * nothing like the rest of the app, and behaves differently in every browser. This is our own
 * list — and, like Select, it's portalled to <body> so a scrolling parent can't clip it.
 * Free text is always allowed; the suggestions are only a shortcut.
 */
export function SuggestInput({ value, onChange, suggestions, placeholder, style, ariaLabel }: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  placeholder?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const q = value.trim().toLowerCase();
  // Prefix matches first — typing "full" should lead with "Full Stack Developer", not with
  // something that merely contains the word halfway through.
  const matches = q
    ? [...suggestions.filter((s) => s.toLowerCase().startsWith(q)),
       ...suggestions.filter((s) => !s.toLowerCase().startsWith(q) && s.toLowerCase().includes(q))]
      .filter((s) => s.toLowerCase() !== q).slice(0, 8)
    : suggestions.slice(0, 8);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = wrap.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    place();
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrap.current?.contains(t) || menu.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  const pick = (s: string) => { onChange(s); setOpen(false); setHi(0); };

  return (
    <div className="sugi" ref={wrap} style={style}>
      <input className="input" value={value} placeholder={placeholder} aria-label={ariaLabel}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && matches.length) { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp' && matches.length) { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' && open && matches[hi]) { e.preventDefault(); pick(matches[hi]); }
          else if (e.key === 'Escape') setOpen(false);
        }} />
      {open && matches.length > 0 && createPortal(
        <div className="tsel-menu" ref={menu} role="listbox"
          style={{ position: 'fixed', top: pos.top, left: pos.left, minWidth: pos.width }}>
          {matches.map((s, i) => (
            <button key={s} type="button" role="option" aria-selected={i === hi}
              className={`tsel-opt ${i === hi ? 'active' : ''}`}
              onMouseEnter={() => setHi(i)} onClick={() => pick(s)}>
              <span>{s}</span>
            </button>
          ))}
        </div>, document.body)}
    </div>
  );
}
