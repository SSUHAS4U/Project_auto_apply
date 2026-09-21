/**
 * The four fit bands, in ONE place.
 *
 * Every surface that shows a match score — the job card's fit scale, table cells, dashboard
 * lists, the landing page — reads its band from here, so "Good fit" can never mean 55 on one
 * screen and 50 on another (the old ScoreBar used 75/50 while the card used 75/55/40).
 *
 * The bands are NOT equal-width on the 0–100 track: weak is 0–39, fair 40–54, good 55–74 and
 * great 75–100. The scale draws them at those real widths so the marker's position is honest.
 */
export type FitBand = 'weak' | 'fair' | 'good' | 'great';

export interface FitInfo {
  band: FitBand;
  label: string;
  /** 0 = weak … 3 = great — the band's position on the scale. */
  index: number;
}

/** Band edges on the 0–100 track: [start, end) per band, in order. */
export const FIT_BANDS: ReadonlyArray<{ band: FitBand; from: number; to: number; label: string }> = [
  { band: 'weak', from: 0, to: 40, label: 'Weak fit' },
  { band: 'fair', from: 40, to: 55, label: 'Fair fit' },
  { band: 'good', from: 55, to: 75, label: 'Good fit' },
  { band: 'great', from: 75, to: 100, label: 'Great fit' },
];

/** Clamp to 0–100 and round; anything non-finite is treated as unknown by callers, not as 0. */
export function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function fitFromScore(score: number): FitInfo {
  const s = clampScore(score);
  const i = s >= 75 ? 3 : s >= 55 ? 2 : s >= 40 ? 1 : 0;
  return { band: FIT_BANDS[i].band, label: FIT_BANDS[i].label, index: i };
}

/**
 * A verdict written by the AI ("Strong fit", "Poor match" …) overrides the derived label but
 * still needs a band for its colour. Unknown wording falls back to the score's own band, so a
 * verdict can never leave a score uncoloured.
 */
export function fitFrom(score: number, verdict?: string): FitInfo {
  const base = fitFromScore(score);
  if (!verdict || !verdict.trim()) return base;
  const v = verdict.toLowerCase();
  const i = /strong|great|excellent/.test(v) ? 3
    : /good/.test(v) ? 2
    : /fair|partial|moderate|\bok\b/.test(v) ? 1
    : /weak|poor|low|bad/.test(v) ? 0
    : base.index;
  return { band: FIT_BANDS[i].band, label: verdict.trim(), index: i };
}
