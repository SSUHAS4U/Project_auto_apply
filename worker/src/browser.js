// Persistent browser + the live-frame streamer that powers the dashboard's "Watch Live".
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Launch a real, visible Chromium with a persistent profile, so the owner logs into
 * each portal ONCE and the session survives restarts. This is the whole safety story:
 * real browser, real session, home IP.
 */
export async function launchBrowser() {
  const userDataDir = path.join(__dirname, '..', '.profile'); // persisted logins live here
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
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
