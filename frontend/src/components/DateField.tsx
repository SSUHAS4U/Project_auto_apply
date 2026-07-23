import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

/**
 * A fully themed date / month picker.
 *
 * Native <input type="date"> hands the calendar to the browser: it's drawn by the OS, can't
 * be styled beyond color-scheme, and looks nothing like the rest of the app. This renders our
 * own calendar in our own markup, so it inherits the theme tokens and matches light and dark
 * automatically.
 *
 * Values stay in the same ISO shapes the profile already stores, so it's a drop-in swap:
 *   mode="date"  -> "YYYY-MM-DD"
 *   mode="month" -> "YYYY-MM"
 *
 * Navigation is two-level — the day grid's title opens a month+year view — because reaching a
 * date of birth by clicking "previous month" twenty years is not a real interaction.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const pad = (n: number) => String(n).padStart(2, '0');

/** Parse the stored value without going through Date() (which applies a timezone shift). */
function parseValue(v: string, mode: 'date' | 'month') {
  const m = mode === 'month' ? /^(\d{4})-(\d{2})$/.exec(v || '') : /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  if (!m) return null;
  return { y: +m[1], mo: +m[2] - 1, d: mode === 'month' ? 1 : +m[3] };
}

function display(v: string, mode: 'date' | 'month') {
  const p = parseValue(v, mode);
  if (!p) return '';
  return mode === 'month' ? `${MON_SHORT[p.mo]} ${p.y}` : `${p.d} ${MON_SHORT[p.mo]} ${p.y}`;
}

/** Monday-first grid of the 42 cells covering the given month. */
function monthGrid(y: number, mo: number) {
  const first = new Date(y, mo, 1);
  const lead = (first.getDay() + 6) % 7;           // Sun=0 -> Monday-first offset
  const start = new Date(y, mo, 1 - lead);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), out: d.getMonth() !== mo };
  });
}

export function DateField({ value, onChange, mode = 'date', placeholder, ariaLabel, disabled, style }: {
  value: string;
  onChange: (v: string) => void;
  mode?: 'date' | 'month';
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  // month mode has no day grid, so it always opens on the month+year view
  const [picking, setPicking] = useState<'day' | 'month'>(mode === 'month' ? 'month' : 'day');
  const today = new Date();
  const sel = parseValue(value, mode);
  const [view, setView] = useState({ y: sel?.y ?? today.getFullYear(), mo: sel?.mo ?? today.getMonth() });
  const ref = useRef<HTMLDivElement>(null);

  // Re-sync the view when the value changes underneath us (e.g. résumé auto-fill).
  useEffect(() => {
    const p = parseValue(value, mode);
    if (p) setView({ y: p.y, mo: p.mo });
  }, [value, mode]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggle = () => {
    if (disabled) return;
    setPicking(mode === 'month' ? 'month' : 'day');
    setOpen((o) => !o);
  };
  const pickDay = (c: { y: number; mo: number; d: number }) => {
    onChange(`${c.y}-${pad(c.mo + 1)}-${pad(c.d)}`);
    setOpen(false);
  };
  const pickMonth = (mo: number) => {
    if (mode === 'month') { onChange(`${view.y}-${pad(mo + 1)}`); setOpen(false); return; }
    setView({ y: view.y, mo });      // date mode: month view is just navigation
    setPicking('day');
  };
  const step = (dir: number) => {
    if (picking === 'month') { setView({ ...view, y: view.y + dir }); return; }
    const mo = view.mo + dir;
    setView({ y: view.y + Math.floor(mo / 12), mo: ((mo % 12) + 12) % 12 });
  };

  const shown = display(value, mode);
  const cells = monthGrid(view.y, view.mo);

  return (
    <div className="dpk" ref={ref} style={style}>
      <button type="button" className={`dpk-btn ${shown ? '' : 'empty'}`} onClick={toggle}
        disabled={disabled} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open}>
        <span className="dpk-val">{shown || placeholder || (mode === 'month' ? 'Month & year' : 'Select a date')}</span>
        <Icon name="clock" size={14} />
      </button>

      {open && (
        <div className="dpk-pop" role="dialog" aria-label={ariaLabel || 'Choose a date'}>
          <div className="dpk-head">
            <button type="button" className="dpk-nav" onClick={() => step(-1)}
              aria-label={picking === 'month' ? 'Previous year' : 'Previous month'}>
              <Icon name="chevron" size={15} style={{ transform: 'rotate(90deg)' }} />
            </button>
            <button type="button" className="dpk-title"
              onClick={() => mode === 'date' && setPicking(picking === 'day' ? 'month' : 'day')}>
              {picking === 'month' ? view.y : `${MONTHS[view.mo]} ${view.y}`}
            </button>
            <button type="button" className="dpk-nav" onClick={() => step(1)}
              aria-label={picking === 'month' ? 'Next year' : 'Next month'}>
              <Icon name="chevron" size={15} style={{ transform: 'rotate(-90deg)' }} />
            </button>
          </div>

          {picking === 'day' ? (
            <>
              <div className="dpk-dow">{DOW.map((d) => <span key={d}>{d}</span>)}</div>
              <div className="dpk-grid">
                {cells.map((c, i) => {
                  const isSel = !!sel && sel.y === c.y && sel.mo === c.mo && sel.d === c.d;
                  const isToday = c.y === today.getFullYear() && c.mo === today.getMonth() && c.d === today.getDate();
                  return (
                    <button type="button" key={i} onClick={() => pickDay(c)}
                      className={`dpk-day ${c.out ? 'out' : ''} ${isSel ? 'sel' : ''} ${isToday ? 'today' : ''}`}>
                      {c.d}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="dpk-months">
              {MON_SHORT.map((m, i) => {
                const isSel = !!sel && sel.y === view.y && sel.mo === i;
                return (
                  <button type="button" key={m} onClick={() => pickMonth(i)}
                    className={`dpk-mon ${isSel ? 'sel' : ''}`}>{m}</button>
                );
              })}
            </div>
          )}

          <div className="dpk-foot">
            <button type="button" className="dpk-link" onClick={() => {
              onChange(mode === 'month'
                ? `${today.getFullYear()}-${pad(today.getMonth() + 1)}`
                : `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`);
              setOpen(false);
            }}>{mode === 'month' ? 'This month' : 'Today'}</button>
            <button type="button" className="dpk-link danger"
              onClick={() => { onChange(''); setOpen(false); }}>Clear</button>
          </div>
        </div>
      )}
    </div>
  );
}
