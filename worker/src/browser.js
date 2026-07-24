// Persistent, human-looking browser + the pause/heartbeat poller for the dashboard.
import { chromium, firefox } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

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
      return { ctx, page: await harden(ctx) };
    } catch (e) {
      log(`  ! Bundled browser failed to start (${String(e.message).slice(0, 120)}) — using Chrome.`);
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

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Human-ish jitter so actions never fire at a robotic fixed cadence. */
export function humanDelay(min = 700, max = 1800) {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}

/**
 * Poll the backend so the main loop halts promptly when the owner hits Pause, and so the
 * dashboard keeps seeing the worker's heartbeat. Replaces the old 1-JPEG/sec "Watch Live"
 * streamer — that uploaded a screenshot every second, which burned the VM's free egress
 * budget for a feature nobody used. Returns a stop().
 */
export function startPausePoller(api, state) {
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      try {
        // /next heartbeats the worker (dashboard "desktop ready") and reports the pause flag.
        // It's a GET that only promotes queued→running, so polling it mid-run is a no-op.
        const r = await api.next();
        state.paused = !!(r && r.paused);
      } catch (_) { /* transient network — try again next tick */ }
      await sleep(4000);
    }
  };
  tick();
  return () => { stopped = true; };
}
