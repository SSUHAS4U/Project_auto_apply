import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { CompanyLogo } from './CompanyLogo';
import { deriveJobFacts } from '../lib/jobFacts';

/**
 * The one job card, used by the Jobs board, Daily picks, Scout and the LinkedIn / Indeed
 * panels. Left column is the posting, right column is the verdict.
 *
 * Employment type, experience and the skill split aren't stored — they're derived from the
 * posting text against your profile (see lib/jobFacts). Whatever the text doesn't say prints
 * "Not mentioned", so a thin listing reads as thin rather than as a broken card.
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
  actions?: ReactNode;          // primary buttons (Apply / Track / …)
  extras?: ReactNode;           // icon buttons next to the source pill
  onOpen?: () => void;
}

const MAX_TAGS = 4;

function fitTone(score?: number, verdict?: string): { tone: string; label: string } {
  if (verdict) {
    const v = verdict.toLowerCase();
    const tone = v.includes('strong') || v.includes('great') ? 'green'
      : v.includes('good') ? 'blue' : v.includes('weak') || v.includes('poor') ? 'red' : 'amber';
    return { tone, label: verdict };
  }
  const s = score ?? 0;
  if (s >= 75) return { tone: 'green', label: 'Great fit' };
  if (s >= 55) return { tone: 'blue', label: 'Good fit' };
  if (s >= 40) return { tone: 'amber', label: 'Fair fit' };
  return { tone: 'red', label: 'Weak fit' };
}

/** A fact cell that degrades to an explicit "Not mentioned". */
function Fact({ ico, value }: { ico: string; value: string | null }) {
  return value
    ? <span><Icon name={ico} size={13} /> {value}</span>
    : <span className="na"><Icon name={ico} size={13} /> Not mentioned</span>;
}

export function JobCardV2(p: JobCardV2Props) {
  const facts = deriveJobFacts(
    `${p.title ?? ''} ${p.description ?? ''}`,
    p.skills ?? [],
    { remote: p.remote, location: p.location },
  );
  const fit = fitTone(p.score, p.verdict);
  const matched = facts.matched.slice(0, MAX_TAGS);
  const missing = facts.missing.slice(0, MAX_TAGS);
  const hidden = (facts.matched.length - matched.length) + (facts.missing.length - missing.length);
  // Location and work mode are often the same word ("Remote") — don't print it twice.
  const place = p.location && p.location.toLowerCase() !== (facts.workMode ?? '').toLowerCase()
    ? p.location : facts.workMode;

  return (
    <div className="jc2">
      <div className="jc2-main">
        <div className="jc2-head">
          <CompanyLogo company={p.company || p.title} size={42} radius={12} />
          <div className="jc2-id">
            {p.url
              ? <a className="jc2-title" href={p.url} target="_blank" rel="noreferrer" title={p.title}>
                  {p.title}<Icon name="external" size={12} style={{ opacity: .55 }} />
                </a>
              : <div className="jc2-title" onClick={p.onOpen}
                  style={{ cursor: p.onOpen ? 'pointer' : undefined }} title={p.title}>{p.title}</div>}
            <div className="jc2-sub">
              {p.company || 'Company not mentioned'}{p.postedLabel ? ` · ${p.postedLabel}` : ''}
            </div>
          </div>
        </div>

        <div className="jc2-meta">
          <Fact ico="target" value={place ?? null} />
          <Fact ico="clipboard" value={facts.employment} />
          <Fact ico="bolt" value={p.salaryText ?? null} />
          <Fact ico="clock" value={facts.experience} />
        </div>

        {(matched.length > 0 || missing.length > 0) && (
          <div className="jc2-tags">
            {matched.map((s) => <span key={`m${s}`} className="jc2-tag ok"><Icon name="check" size={11} /> {s}</span>)}
            {matched.length > 0 && missing.length > 0 && <span className="jc2-divider" />}
            {missing.map((s) => <span key={`g${s}`} className="jc2-tag gap" title="Asked for, not on your profile">{s}</span>)}
            {hidden > 0 && <span className="jc2-more">+{hidden}</span>}
          </div>
        )}

        <div className="jc2-foot">
          <span className="jc2-src">
            sourced from {p.source ? <Icon name={p.source} size={12} /> : null} {p.source || 'unknown'}
          </span>
          {p.extras && <span className="jc2-acts">{p.extras}</span>}
        </div>
      </div>

      <div className="jc2-side">
        {typeof p.score === 'number' && (
          <div className={`fitpanel tone-${fit.tone}`}>
            <div className="fitpanel-n">{p.score}<span>%</span></div>
            <div className="fitpanel-t">{fit.label}</div>
          </div>
        )}
        {p.actions && <div className="jc2-btns">{p.actions}</div>}
      </div>
    </div>
  );
}
