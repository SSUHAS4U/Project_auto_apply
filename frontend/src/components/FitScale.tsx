import { FIT_BANDS, clampScore, fitFrom, fitFromScore } from '../lib/fit';

/**
 * The match score, placed on its scale.
 *
 * A bare "74%" says nothing about whether 74 is good; a ring or a single bar says it again
 * with more ink. This shows the number, the verdict in words, and the four bands at their
 * real widths with a marker where the score falls — so "near the top of Good" reads at a
 * glance, and the word (not only the colour) carries the verdict for anyone who can't tell
 * the band colours apart.
 *
 * Hover or keyboard focus opens the reasons. Rows appear only for facts the posting actually
 * gave: a reason we can't back up is not shown.
 */
export interface FitReasons {
  matched: string[];
  missing: string[];
  /** Experience the posting asks for, e.g. "2–4 yrs". */
  experience?: string | null;
  /** Where the job is, e.g. "Bengaluru" or "Remote". */
  place?: string | null;
}

export function FitScale({ score, verdict, reasons, company }: {
  score: number;
  verdict?: string;
  reasons?: FitReasons;
  company?: string;
}) {
  const s = clampScore(score);
  const fit = fitFrom(s, verdict);
  const skillTotal = reasons ? reasons.matched.length + reasons.missing.length : 0;
  const hasWhy = !!reasons && (skillTotal > 0 || !!reasons.experience || !!reasons.place);
  return (
    <div className={`fit fit-${fit.band}`} tabIndex={hasWhy ? 0 : undefined}
      aria-label={`Match ${s} out of 100, ${fit.label}`}>
      <div className="fit-top">
        <span className="fit-n">{s}</span>
        <span className="fit-of">/100</span>
        <span className="fit-lbl">{fit.label}</span>
      </div>
      <div className="fit-track" aria-hidden="true">
        {FIT_BANDS.map((b, i) => (
          <i key={b.band} className={i < fit.index ? 'pass' : i === fit.index ? 'on' : ''}
            style={{ flexGrow: b.to - b.from }} />
        ))}
        <span className="fit-pin" style={{ left: `${s}%` }} />
      </div>
      {hasWhy && reasons && (
        <div className="fit-why" role="tooltip">
          <div className="fit-why-h">
            <b>Why {company ? `${company} scored` : 'this scored'} {s}</b>
            <span>{fit.label}</span>
          </div>
          <div className="fit-why-rows">
            {skillTotal > 0 && (
              <div className="fit-why-row">
                <span>Skills</span>
                <span className="fit-why-bar"><i style={{ width: `${(reasons.matched.length / skillTotal) * 100}%` }} /></span>
                <span className="fit-why-v">{reasons.matched.length} of {skillTotal}</span>
              </div>
            )}
            {reasons.experience && (
              <div className="fit-why-row"><span>Experience</span><span className="fit-why-v fit-why-wide">asks {reasons.experience}</span></div>
            )}
            {reasons.place && (
              <div className="fit-why-row"><span>Location</span><span className="fit-why-v fit-why-wide">{reasons.place}</span></div>
            )}
          </div>
          {reasons.missing.length > 0 && (
            <div className="fit-why-miss">
              Missing {reasons.missing.slice(0, 4).map((m) => <span key={m} className="chip chip-gap">{m}</span>)}
              {reasons.missing.length > 4 && <span className="fit-why-v">+{reasons.missing.length - 4}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The compact form for tables and lists: number + a short bar in the band colour, with the
 * verdict as the accessible name. Unknown renders "—", never 0 — a zero is a claim.
 */
export function MiniFit({ score }: { score?: number | null }) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return <span className="mini-fit mini-fit-none">—</span>;
  const s = clampScore(score);
  const fit = fitFromScore(s);
  return (
    <span className={`mini-fit fit-${fit.band}`} title={fit.label} aria-label={`Match ${s}, ${fit.label}`}>
      {s}<span className="mt"><i style={{ width: `${s}%` }} /></span>
    </span>
  );
}
