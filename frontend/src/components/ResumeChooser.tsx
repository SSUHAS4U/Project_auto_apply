import { useRef } from 'react';
import type { ResumeDoc } from '../api/client';
import { Icon } from './Icon';

/** The choice that isn't a library résumé. */
export const NO_RESUME = '__none__';
/** The profile's own file, offered only when the library has nothing sendable. */
export const PROFILE_FILE = '__profile__';

type Option = {
  value: string; title: string; meta: string; icon: string;
  suggested?: boolean; isDefault?: boolean;
};

/**
 * "Which résumé goes with this?" as a set of cards rather than a dropdown: every option is
 * visible at once with its role, so choosing is one click and the suggested match is obvious.
 * A radio group — arrow keys move between cards, as with native radios.
 */
export function ResumeChooser({ resumes, profileFile, value, suggestedId, onChange }: {
  /** Library résumés that can be sent (have a file). */
  resumes: ResumeDoc[];
  /** The profile's résumé filename — offered only when `resumes` is empty. */
  profileFile?: string;
  value: string;
  suggestedId?: string | null;
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const options: Option[] = [
    ...resumes.map((r) => ({
      value: r.id,
      title: r.name,
      meta: [r.role || 'No role set', r.source === 'uploaded' || r.uploaded ? 'Uploaded' : 'Built in Documents'].join(' · '),
      icon: r.source === 'uploaded' || r.uploaded ? 'file' : 'pen',
      suggested: r.id === suggestedId,
      isDefault: !!r.defaultResume,
    })),
    ...(resumes.length === 0 && profileFile
      ? [{ value: PROFILE_FILE, title: profileFile, meta: 'Your profile résumé', icon: 'file' }] : []),
    { value: NO_RESUME, title: "Don't attach a résumé", meta: 'Send the email on its own', icon: 'ban' },
  ];

  // Roving focus: only the selected card (or the first) is in the tab order; arrows move.
  const focusable = options.some((o) => o.value === value) ? value : options[0].value;
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = options[(i + step + options.length) % options.length];
    onChange(next.value);
    (ref.current?.querySelector(`[data-v="${CSS.escape(next.value)}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <div className="rc" role="radiogroup" aria-label="Résumé to send" ref={ref}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} data-v={o.value}
            tabIndex={o.value === focusable ? 0 : -1}
            className={`rc-opt ${on ? 'on' : ''} ${o.value === NO_RESUME ? 'rc-none' : ''}`}
            onClick={() => onChange(o.value)} onKeyDown={(e) => onKey(e, i)}>
            <span className="rc-radio" aria-hidden="true" />
            <span className="rc-ic" aria-hidden="true"><Icon name={o.icon} size={15} /></span>
            <span className="rc-body">
              <span className="rc-t" title={o.title}>{o.title}</span>
              <span className="rc-m" title={o.meta}>{o.meta}</span>
              {(o.suggested || o.isDefault) && (
                <span className="rc-tags">
                  {o.suggested && <span className="chip chip-ok">Matches role</span>}
                  {o.isDefault && <span className="chip chip-neutral">Default</span>}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
