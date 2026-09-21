import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { CompanyLogo } from './CompanyLogo';
import { FitScale } from './FitScale';
import { deriveJobFacts } from '../lib/jobFacts';

/**
 * The one job card, used by the Jobs board, Daily picks, Scout, Saved jobs, the tracker and the
 * LinkedIn / Indeed panels.
 *
 *   [logo] Title ↗                         [ fit scale ]
 *          Company · when
 *          facts (location · type · salary · experience)
 *          skills: matched ✓ … | missing (dashed)
 *   ─────────────────────────────────────────────────────
 *   Source site  [tag]                [actions …] [extras …]
 *
 * Every control sits in ONE row at the bottom, at ONE height. The old layout stacked the score,
 * the status dropdown and a button in a narrow side column, where a full-width score panel and
 * button sat above and below a dropdown or badge that only hugged its text — which is exactly
 * how "Applied ▾" and "Promoted" came to look misplaced.
 *
 * Employment type, experience and the skill split aren't stored — they're derived from the
 * posting text against your profile (see lib/jobFacts). A fact the posting doesn't state is
 * LEFT OUT, not printed as "Not mentioned": four cells apologising for a thin listing read as
 * a broken card, and a shorter card says the same thing honestly.
 */
export interface JobCardV2Props {
  title: string;
  company?: string;
  location?: string;
  remote?: boolean;
  description?: string;
  url?: string;
  source?: string;              // linkedin / greenhouse / …
  postedLabel?: string;         // "today", "2h ago"
  salaryText?: string;
  score?: number;               // 0-100 fit
  verdict?: string;             // overrides the derived "Great fit" label
  skills?: string[];            // profile skills, for the matched/missing split
  /** A small label beside the source — how the job is applied to (Email / ATS / URL). */
  tag?: ReactNode;
  actions?: ReactNode;          // the buttons (Apply / Track / status / Details …)
  extras?: ReactNode;           // icon buttons after the actions (edit / delete / mail …)
  onOpen?: () => void;
}

const MAX_TAGS = 4;

/** A fact the posting stated. One it didn't state renders nothing. */
function Fact({ ico, value }: { ico: string; value: string | null | undefined }) {
  return value ? <span><Icon name={ico} size={14} /> {value}</span> : null;
}

export function JobCardV2(p: JobCardV2Props) {
  const facts = deriveJobFacts(
    `${p.title ?? ''} ${p.description ?? ''}`,
    p.skills ?? [],
    { remote: p.remote, location: p.location },
  );
  const matched = facts.matched.slice(0, MAX_TAGS);
  const missing = facts.missing.slice(0, MAX_TAGS);
  const hidden = (facts.matched.length - matched.length) + (facts.missing.length - missing.length);
  // Location and work mode are often the same word ("Remote") — don't print it twice.
  const place = p.location && p.location.toLowerCase() !== (facts.workMode ?? '').toLowerCase()
    ? p.location : facts.workMode;
  const hasScore = typeof p.score === 'number' && Number.isFinite(p.score);

  return (
    <article className={`jc2 ${hasScore ? '' : 'jc2-noscore'}`}>
      {/* Looked up by company or by the company's own domain — never by job title, which
          returned an unrelated logo for "Manual entry" and every listing with no company. */}
      <CompanyLogo company={p.company} label={p.title} url={p.url} size={44} radius={11} />
      <div className="jc2-id">
        {p.url
          ? <a className="jc2-title" href={p.url} target="_blank" rel="noreferrer" title={p.title}>
              <span>{p.title}</span><Icon name="external" size={13} />
            </a>
          : <div className="jc2-title" onClick={p.onOpen}
              style={{ cursor: p.onOpen ? 'pointer' : undefined }} title={p.title}><span>{p.title}</span></div>}
        <div className="jc2-sub">
          <span className={p.company ? '' : 'na'}>{p.company || 'Company not listed'}</span>
          {p.postedLabel && <><span className="sep">·</span><span>{p.postedLabel}</span></>}
        </div>
      </div>

      {hasScore && (
        <FitScale score={p.score!} verdict={p.verdict} company={p.company}
          reasons={{ matched: facts.matched, missing: facts.missing, experience: facts.experience, place }} />
      )}

      {/* Nothing known → no row at all. An empty flex row still carries its gap and leaves a
          hole where the facts should be. */}
      {(place || facts.employment || p.salaryText || facts.experience) && (
        <div className="jc2-meta">
          <Fact ico="target" value={place} />
          <Fact ico="clipboard" value={facts.employment} />
          <Fact ico="bolt" value={p.salaryText} />
          <Fact ico="clock" value={facts.experience} />
        </div>
      )}

      {(matched.length > 0 || missing.length > 0) && (
        <div className="jc2-tags">
          <span className="jc2-tags-l">Skills</span>
          {matched.map((s) => <span key={`m${s}`} className="chip chip-ok"><Icon name="check" size={11} /> {s}</span>)}
          {missing.map((s) => <span key={`g${s}`} className="chip chip-gap" title="Asked for, not on your profile">{s}</span>)}
          {hidden > 0 && <span className="chip chip-neutral">+{hidden}</span>}
        </div>
      )}

      <div className="jc2-foot">
        <span className="jc2-src">
          Source {p.source ? <Icon name={p.source} size={12} /> : null}<b>{p.source || 'unknown'}</b>
          {p.tag}
        </span>
        {(p.actions || p.extras) && (
          <span className="jc2-acts">{p.actions}{p.extras}</span>
        )}
      </div>
    </article>
  );
}
