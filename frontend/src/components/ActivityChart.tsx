import { useMemo, useState } from 'react';
import type { AgentEvent } from '../types';

/**
 * Smooth, stock-style multi-line activity chart. Hand-rolled SVG (no chart library) so it
 * stays theme-aware and dependency-free.
 *
 * One line per outcome (found / relevant / applied / manual / failed), a Day / Week / Month /
 * Year range toggle that re-buckets the x-axis, and a clickable legend to show/hide series.
 * Every point counts DISTINCT JOBS in that bucket (deduped by URL, else title+company) — the
 * same job appears across many city searches, and counting raw events over-inflated everything.
 */

type Range = 'day' | 'week' | 'month' | 'year';
const RANGES: { key: Range; label: string }[] = [
  { key: 'day', label: 'Day' }, { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' }, { key: 'year', label: 'Year' },
];

type Series = { key: string; label: string; color: string; types: string[] };
const SERIES: Series[] = [
  { key: 'found', label: 'Jobs found', color: 'var(--accent)', types: ['job_identified'] },
  { key: 'relevant', label: 'Relevant', color: 'var(--amber)', types: ['relevant'] },
  { key: 'applied', label: 'Applied', color: 'var(--green)', types: ['applied', 'easy_apply'] },
  { key: 'manual', label: 'Manual', color: 'var(--blue)', types: ['manual_apply'] },
  { key: 'failed', label: 'Failed', color: 'var(--red)', types: ['apply_failed'] },
];

const jobKey = (e: AgentEvent) => (e.url || '').trim()
  || ((e.title || '') + '|' + (e.company || '')).toLowerCase().trim();

type Bucket = { start: number; end: number; label: string };
function buildBuckets(range: Range): Bucket[] {
  const now = new Date();
  const out: Bucket[] = [];
  if (range === 'day') {
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 3600_000); d.setMinutes(0, 0, 0);
      out.push({ start: d.getTime(), end: d.getTime() + 3600_000, label: `${String(d.getHours()).padStart(2, '0')}:00` });
    }
  } else if (range === 'week' || range === 'month') {
    const days = range === 'week' ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      out.push({ start: d.getTime(), end: d.getTime() + 86_400_000, label: `${d.getDate()}/${d.getMonth() + 1}` });
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
      out.push({ start: d.getTime(), end, label: d.toLocaleString(undefined, { month: 'short' }) });
    }
  }
  return out;
}

// Catmull-Rom → cubic-bezier: a smooth curve THROUGH every point (no overshoot past 0).
function smoothPath(pts: [number, number][]): string {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

export function ActivityChart({ events, portal }: { events: AgentEvent[]; portal?: 'linkedin' | 'indeed' }) {
  const [range, setRange] = useState<Range>('week');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);

  const { series, buckets } = useMemo(() => {
    const bks = buildBuckets(range);
    const evs = portal ? events.filter((e) => e.portal === portal) : events;
    const data = SERIES.map((s) => {
      const sets = bks.map(() => new Set<string>());
      for (const e of evs) {
        if (!s.types.includes(e.type)) continue;
        const t = new Date(e.createdAt).getTime();
        const bi = bks.findIndex((b) => t >= b.start && t < b.end);
        if (bi >= 0) sets[bi].add(jobKey(e));
      }
      return { ...s, values: sets.map((set) => set.size) };
    });
    return { series: data, buckets: bks };
  }, [events, portal, range]);

  const W = 920, H = 240, padL = 30, padR = 14, padTop = 14, padBot = 30;
  const innerW = W - padL - padR, innerH = H - padTop - padBot;
  const max = Math.max(3, ...series.filter((s) => !hidden.has(s.key)).flatMap((s) => s.values));
  const n = buckets.length;
  const x = (i: number) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => padTop + innerH - (v / max) * innerH;
  const anyData = series.some((s) => s.values.some((v) => v > 0));

  // ~7 evenly spaced x labels so they never collide.
  const step = Math.max(1, Math.round(n / 7));

  const toggle = (k: string) => setHidden((prev) => {
    const nx = new Set(prev); nx.has(k) ? nx.delete(k) : nx.add(k); return nx;
  });

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
        <div className="ac-legend">
          {series.map((s) => {
            const off = hidden.has(s.key);
            const total = s.values.reduce((a, b) => a + b, 0);
            return (
              <button key={s.key} className={`ac-chip ${off ? 'off' : ''}`} onClick={() => toggle(s.key)}>
                <span className="ac-dot" style={{ background: s.color }} />
                {s.label} <b>{total}</b>
              </button>
            );
          })}
        </div>
        <div className="ac-range">
          {RANGES.map((r) => (
            <button key={r.key} className={`ac-range-b ${range === r.key ? 'on' : ''}`} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* position:relative WITHOUT overflow so the tooltip can sit over the edges without
          enabling a horizontal scrollbar; the SVG keeps its own overflow-x for tiny screens. */}
      <div style={{ position: 'relative' }}>
       <div style={{ width: '100%', overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Activity trend"
          style={{ display: 'block' }}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const vbX = ((e.clientX - r.left) / r.width) * W;      // client px → viewBox units
            const i = Math.round(((vbX - padL) / innerW) * (n - 1));
            setHover(Math.max(0, Math.min(n - 1, i)));
          }}
          onMouseLeave={() => setHover(null)}>
          {/* horizontal gridlines + y labels */}
          {[0, 0.5, 1].map((g) => {
            const yy = padTop + (1 - g) * innerH;
            return (
              <g key={g}>
                <line x1={padL} x2={W - padR} y1={yy} y2={yy} stroke="var(--border)" strokeWidth="1" />
                <text x={padL - 6} y={yy + 3.5} fontSize="10" fill="var(--text-faint)" textAnchor="end">{Math.round(max * g)}</text>
              </g>
            );
          })}
          {/* x labels */}
          {buckets.map((b, i) => (i % step === 0 || i === n - 1) && (
            <text key={i} x={x(i)} y={H - 10} fontSize="10" fill="var(--text-faint)" textAnchor="middle">{b.label}</text>
          ))}
          {/* hover guideline — a thin rect (its `x` is CSS-animatable, unlike a line's x1/x2)
              so it GLIDES between points as the cursor moves. */}
          {hover !== null && (
            <rect className="ac-crosshair" x={x(hover) - 0.5} y={padTop} width="1" height={innerH}
              fill="var(--text-faint)" opacity="0.55" />
          )}
          {/* one smooth line per visible series */}
          {series.filter((s) => !hidden.has(s.key)).map((s) => {
            const pts: [number, number][] = s.values.map((v, i) => [x(i), y(v)]);
            return (
              <g key={s.key}>
                <path d={smoothPath(pts)} fill="none" stroke={s.color} strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" opacity="0.95" />
                {n <= 31 && pts.map(([px, py], i) => s.values[i] > 0 && (
                  <circle key={i} cx={px} cy={py} r="2.6" fill={s.color} />
                ))}
                {/* enlarged marker on the hovered bucket — glides between points */}
                {hover !== null && (
                  <circle className="ac-marker" cx={x(hover)} cy={y(s.values[hover])} r="4.5" fill={s.color}
                    stroke="var(--bg-card)" strokeWidth="2" />
                )}
              </g>
            );
          })}
          {!anyData && (
            <text x={W / 2} y={padTop + innerH / 2} fontSize="13" fill="var(--text-faint)" textAnchor="middle">
              No activity yet in this range
            </text>
          )}
        </svg>
       </div>
        {/* hover tooltip — HTML overlay so it reads like the reference: date + each series value.
            Edge-aware: anchored to the RIGHT of the crosshair near the left edge and to the LEFT
            near the right edge, so it never spills past the card (which was forcing a scrollbar). */}
        {hover !== null && anyData && (() => {
          const leftPct = (x(hover) / W) * 100;
          const frac = n > 1 ? hover / (n - 1) : 0.5;
          const style: React.CSSProperties = frac > 0.72
            ? { right: `${100 - leftPct}%`, marginRight: 10 }
            : frac < 0.28
              ? { left: `${leftPct}%`, marginLeft: 10 }
              : { left: `${leftPct}%`, transform: 'translateX(-50%)' };
          return (
            <div className="ac-tip" style={style}>
              <div className="ac-tip-date">{buckets[hover].label}</div>
              {series.filter((s) => !hidden.has(s.key)).map((s) => (
                <div key={s.key} className="ac-tip-row">
                  <span className="ac-dot" style={{ background: s.color }} />
                  <span className="ac-tip-lbl">{s.label}</span>
                  <b>{s.values[hover]}</b>
                </div>
              ))}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
