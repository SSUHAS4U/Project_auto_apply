// Persistent browser + the live-frame streamer that powers the dashboard's "Watch Live".
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
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  };
  try {
    const ctx = await chromium.launchPersistentContext(userDataDir, { ...opts, channel: 'chrome' });
    return { ctx, page: ctx.pages()[0] || (await ctx.newPage()) };
  } catch (e) {
    try {
      const ctx = await chromium.launchPersistentContext(userDataDir, { ...opts, channel: 'msedge' });
      return { ctx, page: ctx.pages()[0] || (await ctx.newPage()) };
    } catch {
      console.error('\n  Could not find Google Chrome (or Microsoft Edge) on this computer.');
      console.error('  Install Chrome from https://www.google.com/chrome and run JobPilot Desktop again.\n');
      throw e;
    }
  }
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Human-ish jitter so actions never fire at a robotic fixed cadence. */
export function humanDelay(min = 700, max = 1800) {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}

/**
 * Stream ~1 downscaled JPEG/sec to the backend for the live panel. Returns a stop()
 * and a way to update the current-action caption + run id. Also surfaces the server's
 * pause flag so the main loop can halt promptly when the owner hits Pause.
 */
export function startFrameStreamer(page, api, state) {
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      try {
        if (!page.isClosed()) {
          const buf = await page.screenshot({ type: 'jpeg', quality: 40 });
          const r = await api.frame({
            runId: state.runId,
            portal: state.portal,
            action: state.action,
            imageB64: buf.toString('base64'),
          });
          if (r && r.paused) state.paused = true;
        }
      } catch { /* a navigation mid-shot is fine; try again next tick */ }
      await sleep(1200);
    }
  };
  tick();
  return () => { stopped = true; };
}
