// JobPilot local worker — the entry point.
//
// Runs on the owner's PC. Opens a real Chromium (persistent profile: log into each
// portal ONCE), then loops: ask the backend what to do (/next), and when a portal run
// is active, drive it while streaming a live screen feed to the dashboard. The backend
// stays the brain (schedule, AI, records, metrics); this is just the hands + eyes.
//
// Setup:
//   1) npm install                 (also downloads Chromium)
//   2) set two env vars (or create worker.config.json — see README):
//        JOBPILOT_BACKEND_URL=https://your-backend
//        JOBPILOT_WORKER_TOKEN=<minted in dashboard → Auto Apply → Agent → "Connect worker">
//   3) npm start   → a browser opens; log into Naukri; hit "Start Naukri" in the dashboard.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api } from './api.js';
import { launchBrowser, startFrameStreamer, sleep } from './browser.js';
import { runNaukri } from './portals/naukri.js';
import { runLinkedIn } from './portals/linkedin.js';
import { runIndeed } from './portals/indeed.js';
import { reportSessions, handleConnectionActions } from './connections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  let cfg = {};
  const file = path.join(__dirname, '..', 'worker.config.json');
  if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const backendUrl = process.env.JOBPILOT_BACKEND_URL || cfg.backendUrl;
  const token = process.env.JOBPILOT_WORKER_TOKEN || cfg.token;
  if (!backendUrl || !token) {
    console.error('\n  Missing config. Set JOBPILOT_BACKEND_URL and JOBPILOT_WORKER_TOKEN');
    console.error('  (or create worker/worker.config.json — see worker/README.md)\n');
    process.exit(1);
  }
  return { backendUrl, token };
}

const ADAPTERS = { naukri: runNaukri, linkedin: runLinkedIn, indeed: runIndeed };

async function main() {
  const { backendUrl, token } = loadConfig();
  const api = new Api(backendUrl, token);

  console.log('Connecting to backend…');
  const hello = await api.hello().catch((e) => { console.error('  Auth failed:', e.message); process.exit(1); });
  console.log(`  Connected as ${hello.name || hello.userId}.`);

  const { ctx, page } = await launchBrowser();
  console.log('\n  Browser is open. Log into the portals you want to use:');
  console.log('   • Naukri:   https://www.naukri.com/');
  console.log('   • LinkedIn: https://www.linkedin.com/');
  console.log('   • Indeed:   https://www.indeed.com/');
  console.log('  (log in once — the session is remembered). Then hit ▶ for a portal in the dashboard.\n');
  await page.goto('https://www.naukri.com/').catch(() => {});

  const state = { runId: null, portal: null, action: 'Idle — waiting for a run', paused: false };
  const stopStream = startFrameStreamer(page, api, state);

  // graceful shutdown
  let running = true;
  const shutdown = async () => { running = false; stopStream(); await ctx.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  let sessionTick = 0;
  while (running) {
    // Connection handling every loop: act on Connect/Disconnect requests, and report
    // session status periodically (every ~6th idle tick) so the dashboard stays live.
    await handleConnectionActions(ctx, page, api).catch(() => {});
    if (sessionTick++ % 6 === 0) await reportSessions(ctx, api).catch(() => {});

    let order;
    try { order = await api.next(); } catch (e) { console.error('poll error:', e.message); await sleep(5000); continue; }

    if (order.paused) { state.action = 'Paused'; state.paused = true; await sleep(4000); continue; }
    if (order.idle || !order.runId) { state.action = 'Idle — waiting for a run'; state.paused = false; await sleep(4000); continue; }

    const adapter = ADAPTERS[order.portal];
    if (!adapter) {
      state.action = `No adapter for ${order.portal} yet`;
      await api.runStatus(order.runId, 'done', `No worker adapter for ${order.portal} yet`);
      await sleep(4000);
      continue;
    }

    // execute the block
    state.runId = order.runId;
    state.portal = order.portal;
    state.paused = false;
    console.log(`▶ Running ${order.portal} block (run ${order.runId})`);
    await api.runStatus(order.runId, 'running', `Working ${order.portal}`);
    try {
      const res = await adapter(page, api, order.plan, state, ctx);
      await api.runStatus(order.runId, 'done', `Block complete — ${res.applied || 0} applied`);
      console.log(`✓ ${order.portal} block done — ${res.applied || 0} applied`);
    } catch (e) {
      console.error(`✗ ${order.portal} block failed:`, e.message);
      await api.event({ runId: order.runId, portal: order.portal, type: 'error', detail: String(e).slice(0, 200) });
      await api.runStatus(order.runId, 'failed', e.message.slice(0, 120));
    }
    state.runId = null; state.portal = null; state.action = 'Idle — waiting for a run';
    await sleep(3000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
