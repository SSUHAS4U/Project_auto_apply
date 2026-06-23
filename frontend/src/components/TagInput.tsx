import { useRef, useState } from 'react';

/** Chip/tag input: type + Enter (or comma) to add, × to remove, with optional
 *  autocomplete suggestions that filter as you type. Backspace on empty removes the last. */
export function TagInput({ value, onChange, suggestions = [], placeholder }: {
  value: string[];
  onChange: (v: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
}) {
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const has = (s: string) => value.some((v) => v.toLowerCase() === s.trim().toLowerCase());
  const add = (s: string) => {
    const t = s.trim();
    if (t && !has(t)) onChange([...value, t]);
    setInput(''); setHi(0);
  };
  const remove = (s: string) => onChange(value.filter((v) => v !== s));

  const matches = input.trim()
    ? suggestions.filter((s) => s.toLowerCase().includes(input.toLowerCase()) && !has(s)).slice(0, 8)
    : [];

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (open && matches[hi]) add(matches[hi]); else add(input);
    } else if (e.key === 'Backspace' && !input && value.length) {
      remove(value[value.length - 1]);
    } else if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); setOpen(true);
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault(); setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="taginput" ref={wrapRef}>
      <div className="taginput-box" onClick={() => wrapRef.current?.querySelector('input')?.focus()}>
        {value.map((s) => (
          <span key={s} className="tag">{s}<button type="button" className="tag-x" onClick={() => remove(s)} aria-label={`Remove ${s}`}>×</button></span>
        ))}
        <input
          className="taginput-field"
          value={input}
          placeholder={value.length ? '' : (placeholder ?? 'Type and press Enter…')}
          onChange={(e) => { setInput(e.target.value); setOpen(true); setHi(0); }}
          onKeyDown={onKey}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
      </div>
      {open && matches.length > 0 && (
        <div className="taginput-suggest">
          {matches.map((s, i) => (
            <button key={s} type="button" className={`taginput-opt ${i === hi ? 'hi' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); add(s); }} onMouseEnter={() => setHi(i)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
