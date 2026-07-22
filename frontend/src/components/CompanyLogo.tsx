import { useState } from 'react';

/**
 * A company's real logo, resolved by NAME via Logo.dev's CDN (img.logo.dev/name/…), with a
 * graceful fall back to a coloured initial tile when there's no match. `fallback=404` makes
 * Logo.dev return an error instead of its own monogram, so misses land on OUR initials — no
 * stray monograms, no attribution needed (personal use). Logos are CDN-cached, so the same
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

export function CompanyLogo({ company, size = 44, radius }: { company?: string; size?: number; radius?: number }) {
  const [failed, setFailed] = useState(false);
  const name = (company ?? '').trim();
  const useImg = !!name && !!TOKEN && !failed;
  const px = Math.round(size);
  const src = useImg
    ? `https://img.logo.dev/name/${encodeURIComponent(name)}?token=${TOKEN}&size=${px * 2}&format=png&theme=${appTheme()}&fallback=404`
    : '';

  return (
    <span
      className={`clogo ${useImg ? '' : 'clogo-mono'}`}
      style={{ width: px, height: px, borderRadius: radius ?? Math.round(px * 0.28), fontSize: Math.round(px * 0.42) }}
      aria-hidden="true">
      {useImg
        ? <img src={src} alt="" width={px} height={px} loading="lazy" onError={() => setFailed(true)} />
        : initialOf(name)}
    </span>
  );
}
