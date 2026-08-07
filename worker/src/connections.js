// Portal connection handling — the "Connect" UX, worker side.
//
// The connection IS the logged-in browser session on this PC. Each loop we:
//  1) report to the backend whether each portal has a live session (by auth cookie),
//  2) pull any Connect/Disconnect requests the dashboard queued and act on them
//     (open the portal's login page, or clear its cookies).
// Cookies never leave this machine — the backend only ever sees a true/false status.
import fs from 'node:fs';
import path from 'node:path';
import { humanDelay, APP_DIR } from './browser.js';

const PORTALS = {
  linkedin: { home: 'https://www.linkedin.com', login: 'https://www.linkedin.com/login', cookie: 'li_at' },
  indeed:   { home: 'https://www.indeed.com',    login: 'https://secure.indeed.com/account/login', cookie: 'PPID' },
};

/**
 * True if the persistent context holds this portal's AUTH cookie. Nothing else counts.
 *
 * This used to fall back to "any long-lived cookie whose name looks session-ish":
 *
 *     /(_at|session|SID|login|auth)/i.test(c.name) && c.value.length > 20
 *
 * `SID` matches `JSESSIONID`, which LinkedIn sets for anonymous visitors — so a completely
 * signed-out profile passed this check. Everything downstream then went wrong at once: the
 * Connections card showed a green "Active" for a dead session, the per-portal gate that is
 * supposed to open a login window never fired because it believed we were signed in, and the
 * run went ahead and finished 0/0/0 against a signed-out job search. The dashboard was
 * confidently contradicting the log, and the only cookie that actually decides was being
 * overruled by a regex.
 *
 * `li_at` / `PPID` are set at sign-in and cleared at sign-out. That is the whole question.
 * Failing closed here is also the right direction: the cost of a false "signed out" is one
 * unnecessary login window, and the cost of a false "signed in" is every run silently doing
 * nothing — which is what has been happening.
 */
export async function isLoggedIn(ctx, portal) {
  const spec = PORTALS[portal];
  if (!spec) return false;
  try {
    const cookies = await ctx.cookies(spec.home);
    return cookies.some((c) => c.name === spec.cookie && (c.value || '').length > 0);
  } catch {
    return false;
  }
}

/** Where to send someone whose session for this portal has lapsed. One list, not two. */
export function loginUrl(portal) {
  return (PORTALS[portal] || PORTALS.linkedin).login;
}

/**
 * Is ANY portal actually signed in RIGHT NOW, judged by the real cookies in the profile?
 *
 * This is the authority for the headless-vs-window decision. The `.signed-in` marker can
 * outlive the session it was written for — the cookie expires, the profile is reset, or the
 * app is reinstalled — and then a marker-only check runs the browser headless against a dead
 * session with no way to log back in. The cookies never lie; the marker is only a hint.
 */
export async function anyPortalLoggedIn(ctx) {
  for (const portal of Object.keys(PORTALS)) {
    if (await isLoggedIn(ctx, portal)) return true;
  }
  return false;
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
  let anySignedIn = false;
  for (const portal of Object.keys(PORTALS)) {
    try {
      const loggedIn = await isLoggedIn(ctx, portal);
      if (loggedIn) anySignedIn = true;
      await api.session(portal, loggedIn, loggedIn ? 'session active' : 'not logged in');
    } catch { /* keep going */ }
  }
  // The moment ANY portal is signed in, record it: every later start can then run with no
  // window at all. This is what turns "watch a browser drive itself" into a background job.
  try {
    const marker = path.join(APP_DIR, '.signed-in');
    if (anySignedIn && !fs.existsSync(marker)) {
      fs.writeFileSync(marker, new Date().toISOString());
      console.log('\n  ✓ Signed in — from the next start this runs invisibly in the background.\n');
    }
  } catch { /* non-fatal */ }
}

/**
 * Pull queued Connect/Disconnect actions and act on them. For "connect" we open the
 * portal's login page in a focused tab so the owner can sign in; for "disconnect" we
 * clear that portal's cookies. Returns true if it opened a login (so the caller can pause
 * autonomous work while the owner authenticates).
 */
/**
 * When each portal's login window was last opened.
 *
 * The main loop calls this roughly every four seconds. Since v133 a connect request survives
 * until the worker acknowledges it — which is right, because delivery is not proof — but it
 * means a request whose ack never lands is re-attempted on EVERY tick. Each attempt closes the
 * headless context and relaunches the browser, so a single stuck request turned into the
 * browser being torn down and rebuilt every four seconds.
 *
 * Firefox writes cookies to cookies.sqlite lazily. A profile closed and reopened that fast
 * never gets to flush, so a sign-in completed in one window was gone by the next — which is
 * exactly "it says connected, then the login is wiped out". Retry, but at human speed.
 */
const lastConnectAttempt = new Map();
const CONNECT_RETRY_MS = 90_000;

/**
 * Clear the retry throttle. Only the tests use this: the throttle is deliberately module-level
 * state that outlives a single call, so without a reset each test would inherit the previous
 * one's cooldown and silently assert nothing.
 */
export function resetConnectThrottle() { lastConnectAttempt.clear(); }

export async function handleConnectionActions(ctx, page, api, showWindow) {
  let openedLogin = false;
  let actions = [];
  try { actions = await api.connectionActions(); } catch { return false; }

  for (const { portal, action } of actions) {
    const spec = PORTALS[portal];
    if (!spec) continue;
    if (action === 'connect') {
      // Already signed in? Then the request is done, whatever the ack did. Without this a
      // successful sign-in whose ack failed would keep reopening the login page forever.
      if (await isLoggedIn(ctx, portal)) {
        await api.session(portal, true, 'session active').catch(() => {});
        await api.connectionAck(portal, true, 'Signed in.').catch(() => {});
        continue;
      }
      const since = Date.now() - (lastConnectAttempt.get(portal) || 0);
      if (since < CONNECT_RETRY_MS) continue;   // a window is already open; let them type
      lastConnectAttempt.set(portal, Date.now());
      try {
        // A login page opened in a HEADLESS context renders nowhere. Once any portal had been
        // signed in the app runs with no window, so clicking Connect dutifully navigated an
        // invisible tab to the login form and reported success — from the owner's side the
        // button simply did nothing, forever, which is exactly the state to be stuck in when
        // a session has expired. Ask the caller for a real window first; it owns the browser
        // lifecycle, so it is the only place that can relaunch non-headless.
        if (showWindow) ctx = (await showWindow()) || ctx;
        const p = await ctx.newPage();
        await p.bringToFront().catch(() => {});
        // The navigation is NOT allowed to fail quietly. `.catch(() => {})` here meant a
        // blank tab counted as a successful Connect.
        await p.goto(spec.login, { waitUntil: 'domcontentloaded' });
        openedLogin = true;
        // Flip the card to "Active" the moment sign-in completes, without waiting for the
        // periodic sweep. Detached watcher (doesn't block the main loop or a running block).
        watchLogin(ctx, api, portal);
        console.log(`\n  → Connect ${portal}: sign in in the window that just opened.`);
        console.log('     It detects the sign-in by itself — nothing else to click.\n');
        // Only NOW is the request finished. Until this lands the backend keeps it queued, so
        // a failure below turns into a retry next tick rather than a click thrown away.
        await api.connectionAck(portal, true, 'Login page opened — waiting for sign-in.').catch(() => {});
      } catch (e) {
        // Every failure here used to be swallowed whole by `catch { /* ignore */ }`, while the
        // backend had already deleted the request. A browser that would not relaunch, a locked
        // profile directory, a dead context — all of them looked identical from the dashboard:
        // a card stuck on "Waiting for sign-in…" and a button that did nothing. Say it, and
        // leave the request queued so the next tick tries again.
        const why = String(e && e.message ? e.message : e).slice(0, 160);
        console.log(`\n  ! Could not open the ${portal} login window: ${why}`);
        console.log('     Retrying on the next tick — the request stays queued.\n');
        await api.connectionAck(portal, false, `Could not open the login window: ${why}`).catch(() => {});
      }
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
        await api.connectionAck(portal, true, 'Disconnected — cookies cleared.').catch(() => {});
      } catch (e) {
        const why = String(e && e.message ? e.message : e).slice(0, 160);
        console.log(`  ! Could not disconnect ${portal}: ${why}`);
        await api.connectionAck(portal, false, `Could not disconnect: ${why}`).catch(() => {});
      }
    }
    await humanDelay(400, 900);
  }
  return openedLogin;
}
