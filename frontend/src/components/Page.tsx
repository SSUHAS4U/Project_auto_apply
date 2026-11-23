import type { ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * The building blocks every screen is made of, so the app reads as ONE product rather than a
 * set of pages styled one at a time. docs/UI_SPEC.md → "Building blocks".
 *
 *   PageHeader   title · what the page is for · the page's actions (one primary at most)
 *   Panel        a section: icon · title · what it's used for · actions, then body, then footer
 *   SettingRow   label + explanation on the left, the control on the right (stacks when narrow)
 *   TriState     Yes / No / Not set as one segmented control — replaces yes/no dropdowns
 *   EmptyState   an empty list says WHY it's empty and what to do next
 */

export function PageHeader({ title, sub, actions, badge }: {
  title: ReactNode; sub?: ReactNode; actions?: ReactNode; badge?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        <h1 className="page-title">{title}{badge && <span className="page-badge">{badge}</span>}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      {actions && <div className="page-acts">{actions}</div>}
    </div>
  );
}

export function Panel({ icon, title, sub, actions, footer, children, id, flush, tone }: {
  icon?: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode; footer?: ReactNode;
  children?: ReactNode; id?: string;
  /** Body without padding — for lists whose rows carry their own. */
  flush?: boolean;
  /** 'danger' marks a destructive section (a red hairline, not a red fill). */
  tone?: 'danger';
}) {
  return (
    <section className={`card sc ${tone ? `sc-${tone}` : ''}`} id={id}>
      <div className="sc-h">
        {icon && <span className="sc-ic"><Icon name={icon} size={15} /></span>}
        <div className="sc-t"><h3>{title}</h3>{sub && <div className="sc-sub">{sub}</div>}</div>
        {actions && <div className="sc-acts">{actions}</div>}
      </div>
      {children != null && <div className={flush ? 'sc-b-flush' : 'sc-b'}>{children}</div>}
      {footer && <div className="sc-f">{footer}</div>}
    </section>
  );
}

export function SettingRow({ label, hint, children, htmlFor }: {
  label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string;
}) {
  return (
    <div className="srow">
      <div className="srow-l">
        {htmlFor ? <label className="srow-t" htmlFor={htmlFor}>{label}</label> : <div className="srow-t">{label}</div>}
        {hint && <div className="srow-d">{hint}</div>}
      </div>
      <div className="srow-c">{children}</div>
    </div>
  );
}

/** Yes / No / Not set. `null` is a real answer here: "leave this question for me". */
export function TriState({ value, onChange, label }: {
  value: boolean | null; onChange: (v: boolean | null) => void; label: string;
}) {
  const opts: [boolean | null, string][] = [[true, 'Yes'], [false, 'No'], [null, 'Not set']];
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {opts.map(([v, t]) => (
        <button key={t} type="button" role="radio" aria-checked={value === v}
          className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{t}</button>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: {
  icon: string; title: ReactNode; children?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="empty2">
      <span className="empty2-ic"><Icon name={icon} size={18} /></span>
      <div className="empty2-t">{title}</div>
      {children && <div className="empty2-d">{children}</div>}
      {action}
    </div>
  );
}
