// Persistent, human-looking browser + the pause/heartbeat poller for the dashboard.
import { chromium, firefox } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { logEvent } from './logfile.js';

// When packaged as a single .exe (pkg), the code lives in a virtual snapshot — the profile
// and config must live next to the actual executable. In dev (run from the worker folder
// via npm start), the current working directory is the worker folder. Avoids import.meta so
// the same code works both unbundled (ESM) and bundled (CJS in the packaged app).
export const APP_DIR = process.pkg ? path.dirname(process.execPath) : process.cwd();

/**
 * Launch the automation browser.
 *
 * Preference order:
 *  1. the bundled Camoufox (downloaded on first use) — no dependency on what's installed, and
 *     hardened against the fingerprinting job boards actually check;
 *  2. the user's Chrome / Edge, so an existing setup keeps working if the download fails.
 *
 * `headless` runs it with no window at all: once a portal is signed in, runs happen silently
 * in the background and the terminal log is the only surface. The first run stays visible so
 * the sign-in can actually be done.
 */
export async function launchBrowser({ headless = false, log = console.log } = {}) {
  const userDataDir = path.join(APP_DIR, '.profile'); // persisted logins live here
  fs.mkdirSync(userDataDir, { recursive: true });

  // Firefox profiles are not Chromium profiles — keep them apart so neither corrupts the other.
  const ffDir = path.join(APP_DIR, '.profile-ff');
  const { ensureBrowser } = await import('./browser-setup.js');
  const exe = await ensureBrowser(log).catch(() => null);
  if (exe) {
    try {
      fs.mkdirSync(ffDir, { recursive: true });
      const ctx = await firefox.launchPersistentContext(ffDir, {
        executablePath: exe,
        headless,
        viewport: null,
        // Inherit the machine's real locale/timezone — pinning them is itself a signal.
      });
      log(headless
        ? '  Automation browser running in the background (no window).'
        : '  Automation browser open.');
      log(`     [profile] Camoufox — ${ffDir}`);
      return { ctx, page: await harden(ctx) };
    } catch (e) {
      // Falling back to Chrome switches PROFILE DIRECTORY as well as browser: Camoufox keeps
      // its session in .profile-ff, Chrome in .profile. A sign-in done in one is invisible to
      // the other, so a run that launches Camoufox after you signed in through the Chrome
      // fallback reports "not signed in" against a session that genuinely exists — it is just
      // in the other folder. Say so loudly; a silent fallback makes that indistinguishable
      // from a login that was never saved.
      log(`  ! Bundled browser failed to start (${String(e.message).slice(0, 120)})`);
      log('  ! Falling back to Chrome — NOTE this uses a SEPARATE profile, so portals signed');
      log('    in under the bundled browser will show as signed out until it starts again.');
    }
  }
  const opts = {
    headless,
    // A real window, not a scripted 1280x800 box — a fixed odd viewport is itself a signal.
    viewport: null,
    // Playwright disables the Chrome sandbox by default, which makes Chrome show the yellow
    // "unsupported command-line flag: --no-sandbox" banner. That banner is a loud automation
    // tell that bot-detection (Indeed/Cloudflare) reads — keep the sandbox ON.
    chromiumSandbox: true,
    // Drops the "Chrome is being controlled by automated test software" infobar.
    ignoreDefaultArgs: ['--enable-automation'],
    // Locale/timezone deliberately NOT set: inheriting the real machine's values is more
    // authentic than pinning them.
    // NOTE: '--disable-blink-features=AutomationControlled' is deliberately NOT passed.
    // Current Chrome treats it as unsupported and prints the yellow "You are using an
    // unsupported command-line flag" banner — the very automation tell it was meant to hide.
    // navigator.webdriver is patched in harden() instead, which leaves no banner.
    args: ['--start-maximized'],
  };
  try {
    const ctx = await chromium.launchPersistentContext(userDataDir, { ...opts, channel: 'chrome' });
    log(`     [profile] Chrome — ${userDataDir}`);
    return { ctx, page: await harden(ctx) };
  } catch (e) {
    try {
      const ctx = await chromium.launchPersistentContext(userDataDir, { ...opts, channel: 'msedge' });
      return { ctx, page: await harden(ctx) };
    } catch {
      console.error('\n  Could not find Google Chrome (or Microsoft Edge) on this computer.');
      console.error('  Install Chrome from https://www.google.com/chrome and run JobPilot Desktop again.\n');
      throw e;
    }
  }
}

/**
 * Belt-and-braces fingerprint cleanup applied to every page (including ones the apply flows
 * open later) — patches the few properties automation still leaks, on top of whatever
 * hardening the browser itself provides.
 */
async function harden(ctx) {
  // Record what the browser actually did. Which URL a job page really landed on — a redirect to
  // an authwall, a 999 rate-limit, a challenge — was never written down anywhere, so "the job
  // page did not render" has been an unexplained symptom for days. Attached at the CONTEXT so
  // pages opened later by the apply flows are covered too, and every handler is defensive: a
  // logging listener that throws would break navigation itself.
  const watch = (p) => {
    try {
      p.on('framenavigated', (f) => {
        try { if (f === p.mainFrame()) logEvent('nav', { url: f.url() }); } catch { /* ignore */ }
      });
      p.on('response', (r) => {
        try {
          // LinkedIn's bot detection, caught at the only place it is visible.
          //
          // PerimeterX / HUMAN Security is loaded as li.protechts.net with app_id=PX… and a
          // `uc=scraping` parameter — LinkedIn labelling the session, in as many words. It
          // arrives with a reCAPTCHA Enterprise frame, and once it escalates the job-cards API
          // starts returning 503, results come back empty and the session stops being honoured.
          //
          // Nothing surfaced this. The run read the empty results as "no jobs", printed
          // "0 Easy-Apply jobs" seventy times, announced "every search was exhausted" and
          // finished — while the real answer was sitting in the network traffic all along.
          const u = r.url();
          if (/protechts\.net|perimeterx|px-cdn|recaptcha\/enterprise/i.test(u)) {
            botChallenges++;
            if (botChallenges === 1) logEvent('bot-detection', { first: u.slice(0, 300) });
          }
        } catch { /* ignore */ }
        try {
          // Only the document itself and anything that failed — logging every image would bury
          // the signal and the file would be gigabytes.
          const st = r.status();
          if (st >= 400 || r.request().resourceType() === 'document') {
            logEvent('net', { status: st, type: r.request().resourceType(), url: r.url().slice(0, 300) });
          }
        } catch { /* ignore */ }
      });
      p.on('pageerror', (e) => logEvent('pageerror', String(e && e.message).slice(0, 300)));
      p.on('crash', () => logEvent('pageerror', 'the page crashed'));
    } catch { /* ignore */ }
  };
  ctx.on('page', watch);
  ctx.pages().forEach(watch);

  await ctx.addInitScript(() => {
    // CDP sets this to true; real browsing has it undefined.
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Automation contexts sometimes report zero plugins / empty languages.
    if (!navigator.plugins || navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    }
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    }
  }).catch(() => { /* older Playwright — flags alone still help */ });
  return ctx.pages()[0] || (await ctx.newPage());
}

/**
 * How many times LinkedIn's anti-bot has fired this process. Read by the adapters so an
 * unreadable page can be reported as what it is — a block — rather than as "no results".
 */
let botChallenges = 0;
export function botChallengeCount() { return botChallenges; }

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Human-ish jitter so actions never fire at a robotic fixed cadence. */
export function humanDelay(min = 700, max = 1800) {
  // The adapter test harness sets JOBPILOT_TEST_NO_PACING so a suite that drives dozens of
  // pages finishes in two minutes rather than twenty. Read at CALL time, not at import time:
  // ES module imports are hoisted, so a harness that sets the variable in its own module body
  // would lose the race against this module being evaluated. Nothing in the app ever sets it —
  // the jitter is a large part of what keeps a run from reading as a script.
  if (process.env.JOBPILOT_TEST_NO_PACING === '1') return sleep(0);
  return sleep(min + Math.floor(Math.random() * (max - min)));
}

/**
 * Poll the backend so the main loop halts promptly when the owner hits Pause, and so the
 * dashboard keeps seeing the worker's heartbeat. Replaces the old 1-JPEG/sec "Watch Live"
 * streamer — that uploaded a screenshot every second, which burned the VM's free egress
 * budget for a feature nobody used. Returns a stop().
 */
export function startPausePoller(api, state, reportSessions) {
  let stopped = false;
  let missedRun = 0;   // consecutive polls where our run was not the active one
  let lastReply = '';  // the raw /next body that triggered it — see below
  let ticks = 0;
  const tick = async () => {
    while (!stopped) {
      // Refresh the portal cards DURING a run, not only between blocks.
      //
      // Session status was reported from the main loop only, which a running block owns for up
      // to 90 minutes. So signing in mid-run left the Connections card — and the banner on the
      // portal page — insisting "LinkedIn is not connected" while the terminal was happily
      // applying to jobs. The dashboard was describing a state that had already been fixed, and
      // the only cure was waiting out the whole block. Every 20th tick is once a minute.
      //
      // INSIDE the try, and this matters more than it looks. This loop is the worker's
      // heartbeat: /next below is what tells the backend the desktop app is alive. If anything
      // here throws, the while loop exits, the heartbeat stops, and ten minutes later the
      // stale-run reaper ends a perfectly healthy run with "the desktop app stopped while it
      // was running" — the exact message the dashboard has been showing. A cosmetic card
      // refresh must never be able to kill the heartbeat.
      try {
        if (reportSessions && ticks++ % 20 === 0) await reportSessions().catch(() => {});
        // /next heartbeats the worker (dashboard "desktop ready") and reports the pause flag.
        // It's a GET that only promotes queued→running, so polling it mid-run is a no-op.
        const r = await api.next();
        state.paused = !!(r && r.paused);
        // STOP detection. Clicking Stop marks the run finished, so /next stops returning it.
        // The block loop only re-checks /next between blocks, so without this a Stop wouldn't
        // take effect until the whole current block (all those searches) finished — which read
        // as "it doesn't stop until I disconnect". If the run we're mid-way through has vanished
        // from /next (idle, or a different run), abort it now.
        if (state.runId && !state.paused) {
          const activeId = r && r.runId ? String(r.runId) : null;
          if (activeId !== String(state.runId)) {
            // TWO consecutive observations, not one. A single divergence happens whenever the
            // backend blips — and this flag silently breaks every loop in the running block, so
            // acting on one reading turned a two-second hiccup into a dead hour that printed
            // nothing at all. Say it out loud too: this was invisible before.
            missedRun++;
            // Keep the raw reply. "The server reports nothing running" has now been blamed on
            // the reaper, on backend deploys and on a heartbeat window, and the run records
            // afterwards said `done`, not `failed` — which fits none of those. Guessing from
            // the outside has cost days, so record exactly what /next returned at the moment
            // the decision was made.
            lastReply = JSON.stringify(r || null).slice(0, 200);
            if (missedRun === 2) {
              // Say it ONCE, and say enough to diagnose it. This printed on every subsequent
              // tick, three times in one run, while explaining nothing about the cause — and
              // "it was stopped or ended" covers a Stop click, a finished run, a backend
              // redeploy that dropped the run, and a rotation starting a different portal.
              // Those need different fixes, so name which one it was.
              console.log(`\n  ■ Run ${state.runId} is no longer the active run on the server`
                + ` — ${activeId ? `the server is now running ${activeId}` : 'the server reports nothing running'}.`);
              // The raw reply, because every theory so far has been wrong. This has been blamed
              // on the reaper, on backend deploys and on a 30-second heartbeat window — and the
              // run records afterwards read `done` with "Block complete", which fits none of
              // them. One line here ends the guessing.
              console.log(`     [diag] /next replied: ${lastReply}`);
              console.log('     Finishing this block.');
              state.stopped = true;
            }
          } else {
            missedRun = 0;
          }
        }
      } catch (_) { /* transient network — try again next tick */ }
      await sleep(3000);
    }
  };
  tick();
  return () => { stopped = true; };
}
