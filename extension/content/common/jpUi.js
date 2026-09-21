// JobPilot's look inside OTHER websites: the "J" mark, a few SVG icons, and the light/dark
// palette — the same tokens as the dashboard (frontend/src/styles.css), so the pill and the
// Save button read as JobPilot on any page.
//
// Loaded FIRST among the content scripts (see manifest.json) so assistEngine and fieldEngine
// can use it. Everything is inline-styled on purpose: a page's own CSS can't be trusted to
// leave a class name alone, but it can't reach an inline style.
(function () {
  if (globalThis.JPUI) return;

  const LIGHT = {
    surface: '#FFFFFF', line: '#E3E6EB', ink: '#0F1217', ink2: '#4A5260', ink3: '#737C8A',
    primary: '#0F1217', onPrimary: '#FFFFFF', hover: '#EEF0F3',
    ok: '#157347', danger: '#B42318',
    shadow: '0 2px 4px rgba(15,18,23,.06), 0 16px 40px rgba(15,18,23,.16)',
  };
  const DARK = {
    surface: '#14171C', line: '#353B45', ink: '#ECEEF2', ink2: '#A6ADB8', ink3: '#7D8592',
    primary: '#ECEEF2', onPrimary: '#0F1217', hover: '#1D2128',
    ok: '#4CC38A', danger: '#F2776C',
    shadow: '0 2px 6px rgba(0,0,0,.5), 0 18px 44px rgba(0,0,0,.55)',
  };

  /** The page's colour scheme — we can't see the dashboard's toggle from here. */
  function palette() {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? DARK : LIGHT; }
    catch (_) { return LIGHT; }
  }

  // Lucide paths (ISC), 24×24, stroked.
  const PATHS = {
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4M22 5h-4"/>',
    save: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  };

  function icon(name, size) {
    const s = size || 14;
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" `
      + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;display:block">${PATHS[name] || ''}</svg>`;
  }

  /** The "J" mark on its tile, in the palette's primary pair — the same object as the app logo. */
  function mark(size, pal) {
    const s = size || 22;
    const p = pal || palette();
    return `<svg width="${s}" height="${s}" viewBox="0 0 40 40" aria-hidden="true" style="flex:none;display:block">`
      + `<rect width="40" height="40" rx="11" fill="${p.primary}"/>`
      + `<g stroke="${p.onPrimary}" stroke-width="4.4" stroke-linecap="round" fill="none">`
      + `<path d="M25.5 11.5 V22 a6 6 0 0 1 -12 0"/><path d="M18.5 11.5 H27.5"/></g></svg>`;
  }

  /** A button's inline style, in one of three roles. Height 30px everywhere. */
  function buttonStyle(role, pal) {
    const p = pal || palette();
    const base = 'display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border-radius:8px;'
      + 'font:600 12.5px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;'
      + 'letter-spacing:0;text-transform:none;box-shadow:none;margin:0;transition:background .15s,opacity .15s;';
    if (role === 'primary') return base + `background:${p.primary};color:${p.onPrimary};border:1px solid ${p.primary};`;
    if (role === 'ghost') return base + `background:transparent;color:${p.ink3};border:1px solid transparent;padding:0 7px;`;
    return base + `background:${p.surface};color:${p.ink};border:1px solid ${p.line};`;
  }

  globalThis.JPUI = { palette, icon, mark, buttonStyle };
})();
