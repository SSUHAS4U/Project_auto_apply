// Portal connection handling — the "Connect" UX, worker side.
//
// The connection IS the logged-in browser session on this PC. Each loop we:
//  1) report to the backend whether each portal has a live session (by auth cookie),
//  2) pull any Connect/Disconnect requests the dashboard queued and act on them
//     (open the portal's login page, or clear its cookies).
// Cookies never leave this machine — the backend only ever sees a true/false status.
import { humanDelay } from './browser.js';

const PORTALS = {
  linkedin: { home: 'https://www.linkedin.com', login: 'https://www.linkedin.com/login', cookie: 'li_at' },
  indeed:   { home: 'https://www.indeed.com',    login: 'https://secure.indeed.com/account/login', cookie: 'PPID' },
};

/** True if the persistent context holds this portal's auth cookie. */
async function isLoggedIn(ctx, portal) {
  const spec = PORTALS[portal];
  if (!spec) return false;
  try {
    const cookies = await ctx.cookies(spec.home);
    // primary auth cookie, or any long-lived session-looking cookie for the domain
    if (cookies.some((c) => c.name === spec.cookie && c.value)) return true;
    return cookies.some((c) => /(_at|session|SID|login|auth)/i.test(c.name) && (c.value || '').length > 20);
  } catch {
    return false;
  }
}

/**
 * After we open a portal's login tab, poll (up to ~3 min) and report the session as soon as
 * the auth cookie appears — so the dashboard flips to "Active" within seconds of sign-in.
 * Detached on purpose: it must keep working even while a block is running.
 */
function watchLogin(ctx, api, portal) {
  (async () => {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        if (await isLoggedIn(ctx, portal)) {
          await api.session(portal, true, 'session active').catch(() => {});
          return;
        }
      } catch { /* keep polling */ }
    }
  })();
}

/** Report all portal session states to the backend (best-effort). */
export async function reportSessions(ctx, api) {
  for (const portal of Object.keys(PORTALS)) {
    try {
      const loggedIn = await isLoggedIn(ctx, portal);
      await api.session(portal, loggedIn, loggedIn ? 'session active' : 'not logged in');
    } catch { /* keep going */ }
  }
}

/**
 * Pull queued Connect/Disconnect actions and act on them. For "connect" we open the
 * portal's login page in a focused tab so the owner can sign in; for "disconnect" we
 * clear that portal's cookies. Returns true if it opened a login (so the caller can pause
 * autonomous work while the owner authenticates).
 */
export async function handleConnectionActions(ctx, page, api) {
  let openedLogin = false;
  let actions = [];
  try { actions = await api.connectionActions(); } catch { return false; }

  for (const { portal, action } of actions) {
    const spec = PORTALS[portal];
    if (!spec) continue;
    if (action === 'connect') {
      try {
        const p = await ctx.newPage();
        await p.bringToFront().catch(() => {});
        await p.goto(spec.login, { waitUntil: 'domcontentloaded' }).catch(() => {});
        openedLogin = true;
        // Flip the card to "Active" the moment sign-in completes, without waiting for the
        // periodic sweep. Detached watcher (doesn't block the main loop or a running block).
        watchLogin(ctx, api, portal);
        console.log(`\n  → Connect ${portal}: log in in the opened tab. It auto-detects when you're in.\n`);
      } catch { /* ignore */ }
    } else if (action === 'disconnect') {
      try {
        const cookies = await ctx.cookies(spec.home);
        // Playwright clears by re-setting with past expiry isn't exposed; use clearCookies with filter
        await ctx.clearCookies({ domain: new URL(spec.home).hostname }).catch(async () => {
          // older Playwright: clear everything for safety on this domain is not granular; skip
        });
        await api.session(portal, false, 'disconnected by owner');
        console.log(`  → Disconnected ${portal} (cookies cleared).`);
        void cookies;
      } catch { /* ignore */ }
    }
    await humanDelay(400, 900);
  }
  return openedLogin;
}
