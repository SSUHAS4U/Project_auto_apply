// Persistent, human-looking browser + the pause/heartbeat poller for the dashboard.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

// When packaged as a single .exe (pkg), the code lives in a virtual snapshot — the profile
// and config must live next to the actual executable. In dev (run from the worker folder
// via npm start), the current working directory is the worker folder. Avoids import.meta so
// the same code works both unbundled (ESM) and bundled (CJS in the packaged app).
export const APP_DIR = process.pkg ? path.dirname(process.execPath) : process.cwd();

/**
 * Launch the user's real, installed Google Chrome with a persistent profile, so they log
 * into each portal ONCE and the session survives restarts. Using the system Chrome (rather
 * than a bundled Chromium) keeps the download small and the session indistinguishable from
 * normal use. Falls back to bundled Chromium in dev if present.
 */
export async function launchBrowser() {
  const userDataDir = path.join(APP_DIR, '.profile'); // persisted logins live here
  fs.mkdirSync(userDataDir, { recursive: true });
  const opts = {
    headless: false,
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
 * Belt-and-braces fingerprint cleanup on top of the launch flags, applied to every page
 * (including ones the apply flows open later). We drive the user's REAL Chrome with their
 * real profile, so almost everything is already authentic — these patch the few properties
 * the DevTools protocol still leaks.
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
