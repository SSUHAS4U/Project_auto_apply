import type { ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * One job card, shared across every scored/ranked job list (Jobs board, Engine ranked
 * matches, Daily picks). It renders the identity (company-initial logo, role, company,
 * location, source), an optional score badge (match % or engine verdict), optional
 * salary/badges, optional AI reason lines, and an `actions` slot for the page's own buttons
 * (Apply / Track / Dismiss …). Anything list-specific stays a prop, so no page is forced
 * into another's shape.
 */
export interface JobCardProps {
  title: string;
  company?: string;
  location?: string;
  source?: string;
  url?: string;
  metaRight?: ReactNode;          // e.g. captured/posted date
  score?: number;                 // matchScore or fitScore
  verdict?: string;               // engine verdict (strong/good/moderate/weak/poor)
  salary?: string;
  badges?: ReactNode;             // ApplyBadge, "urgent", etc.
  strengths?: string;
  gaps?: string;
  dealBreaker?: string;
  actions?: ReactNode;
  onOpen?: () => void;            // title click → details (when there's no external url)
  children?: ReactNode;          // expandable content (description)
}

const VERDICT_TONE: Record<string, string> = {
  strong: 'green', good: 'blue', moderate: 'amber', weak: 'amber', poor: 'red',
};
function scoreTone(score?: number, verdict?: string): string {
  if (verdict && VERDICT_TONE[verdict]) return VERDICT_TONE[verdict];
  if (typeof score !== 'number') return 'slate';
  return score >= 80 ? 'green' : score >= 60 ? 'blue' : score >= 40 ? 'amber' : 'red';
}

export function JobCard(p: JobCardProps) {
  const initial = (p.company || p.title || '?').trim().charAt(0).toUpperCase();
  const tone = scoreTone(p.score, p.verdict);
  return (
    <div className="jcard">
      <div className="jcard-logo">{initial}</div>
      <div className="jcard-main">
        <div className="jcard-head">
          <div style={{ minWidth: 0 }}>
            {p.url ? (
              <a href={p.url} target="_blank" rel="noreferrer" className="jcard-title">
                {p.title}<Icon name="external" size={12} style={{ opacity: .55 }} />
              </a>
            ) : (
              <div className="jcard-title" onClick={p.onOpen} style={{ cursor: p.onOpen ? 'pointer' : undefined }}>{p.title}</div>
            )}
            <div className="jcard-sub">
              {p.company && <span>{p.company}</span>}
              {(p.location || p.source) && <>
                {p.company && <span className="jcard-dot">·</span>}
                {p.location && <span>{p.location}</span>}
                {p.location && p.source && <span className="jcard-dot">·</span>}
                {p.source && <span className="faint">{p.source}</span>}
              </>}
            </div>
          </div>
          <div className="jcard-right">
            {typeof p.score === 'number' && (
              <div className={`jcard-score tone-${tone}`}>
                <span className="jcard-score-n">{p.score}</span>
                <span className="jcard-score-c">{p.verdict || 'match'}</span>
              </div>
            )}
            {p.metaRight && <span className="jcard-meta">{p.metaRight}</span>}
          </div>
        </div>

        {(p.badges || p.salary) && (
          <div className="jcard-badges">
            {p.badges}
            {p.salary && <span className="jcard-salary">{p.salary}</span>}
          </div>
        )}

        {p.strengths && <div className="jcard-reason ok"><Icon name="check" size={13} /><span>{p.strengths}</span></div>}
        {p.gaps && <div className="jcard-reason gap"><Icon name="gap" size={13} /><span>{p.gaps}</span></div>}
        {p.dealBreaker && <div className="jcard-reason bad"><Icon name="ban" size={13} /><span>{p.dealBreaker}</span></div>}

        {p.children}
        {p.actions && <div className="jcard-actions">{p.actions}</div>}
      </div>
    </div>
  );
}
