import { useEffect, useState } from 'react';
import { companyDomain } from '../lib/companyDomain';

/**
 * A company's real logo from Logo.dev's CDN, with a graceful fall back to an initial tile.
 *
 * Lookup order, most exact first:
 *   1. by DOMAIN, when the job's URL is on the company's own site (careers.cognizant.com →
 *      cognizant.com). Exact.
 *   2. by NAME (img.logo.dev/name/…). A guess — it returned WordPress for "Cognizant" — so it
 *      is only the fallback, never the first try when a domain is known.
 *   3. the company's initial on a neutral tile.
 * `fallback=404` makes Logo.dev return an error instead of its own monogram, so a miss moves
 * to the next step rather than showing someone else's letter. Logos are CDN-cached, so the same
 * company shown many times is effectively one fetch.
 *
 * The token is a *publishable* key (safe in the browser by design). Override per-deploy with
 * VITE_LOGODEV_TOKEN; empty string disables the network fetch entirely (initials only).
 */
const TOKEN = (import.meta.env.VITE_LOGODEV_TOKEN as string | undefined) ?? 'pk_YTfU81yJQpuRIYZJIxMgAQ';

function initialOf(s?: string): string {
  const t = (s ?? '').trim();
  return t ? t.charAt(0).toUpperCase() : '?';
}

/** Match the logo variant to the app theme so dark wordmarks (e.g. Turing) don't vanish on a
 *  dark tile: theme=dark asks Logo.dev for the light logo, and vice-versa. */
function appTheme(): 'dark' | 'light' {
  if (typeof document !== 'undefined') {
    const t = document.documentElement.dataset.theme;
    if (t === 'light' || t === 'dark') return t;
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

export function CompanyLogo({ company, label, url, size = 44, radius }: {
  /** The employer. The ONLY thing looked up by name — never a job title. */
  company?: string;
  /** Text for the initial when there is no company (e.g. the job title). Never looked up. */
  label?: string;
  /** The job's link. When it is on the company's own site, the logo is looked up by domain. */
  url?: string;
  size?: number;
  radius?: number;
}) {
  const name = (company ?? '').trim();
  const domain = companyDomain(url);
  const sources: string[] = [];
  const px = Math.round(size);
  const q = `token=${TOKEN}&size=${px * 2}&format=png&theme=${appTheme()}&fallback=404`;
  if (TOKEN) {
    if (domain) sources.push(`https://img.logo.dev/${encodeURIComponent(domain)}?${q}`);
    if (name) sources.push(`https://img.logo.dev/name/${encodeURIComponent(name)}?${q}`);
  }
  const key = sources.join('|');
  const [step, setStep] = useState(0);
  // A card reused for a different job (list re-order) must start over at the most exact source.
  useEffect(() => { setStep(0); }, [key]);
  const src = sources[step];

  return (
    <span
      className={`clogo ${src ? '' : 'clogo-mono'}`}
      style={{ width: px, height: px, borderRadius: radius ?? Math.round(px * 0.26), fontSize: Math.round(px * 0.4) }}
      aria-hidden="true">
      {src
        ? <img key={src} src={src} alt="" width={px} height={px} loading="lazy" onError={() => setStep((n) => n + 1)} />
        : initialOf(name || label)}
    </span>
  );
}
