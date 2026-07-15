// Theme handling. HireDue is a light-first product, so light is the default; the choice
// persists across sessions and is applied to <html data-theme> (styles.css keys off it).
export type Theme = 'light' | 'dark';
const KEY = 'jobpilot_theme';

export function getTheme(): Theme {
  return (localStorage.getItem(KEY) as Theme) || 'light';
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(KEY, t);
}

/** Call once at startup, before first paint. */
export function initTheme(): void {
  applyTheme(getTheme());
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'light' ? 'dark' : 'light';
  applyTheme(next);
  return next;
}
