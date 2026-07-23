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
//   3) npm start   → a browser opens; log into LinkedIn; hit ▶ for a portal in the dashboard.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Api } from './api.js';
import { launchBrowser, startPausePoller, sleep, APP_DIR } from './browser.js';
import { runLinkedIn } from './portals/linkedin.js';
import { runIndeed } from './portals/indeed.js';
import { reportSessions, handleConnectionActions } from './connections.js';

const DEFAULT_BACKEND = 'https://35.212.189.37.sslip.io';
const CONFIG_FILE = path.join(APP_DIR, 'jobpilot-desktop.config.json');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

/**
 * First-run setup with zero file editing: if there's no saved token, ask for it once
 * (paste it from the dashboard's Connect screen) and remember it. After that it just runs.
 */
async function loadConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG_FILE)) { try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* re-ask */ } }
  let backendUrl = process.env.JOBPILOT_BACKEND_URL || cfg.backendUrl;
  let token = process.env.JOBPILOT_WORKER_TOKEN || cfg.token;

  if (!token) {
    console.log('\n  Welcome to JobPilot Desktop — first-time setup (takes 20 seconds).\n');
    console.log('  1) Open your JobPilot dashboard → Connections → "Set up".');
    console.log('  2) Click "Generate connect code" and copy it.\n');
    token = await ask('  Paste your connect code here: ');
    if (!token) { console.error('  No code entered. Run me again when you have it.\n'); process.exit(1); }
    if (!backendUrl) {
      const b = await ask(`  Backend URL [${DEFAULT_BACKEND}]: `);
      backendUrl = b || DEFAULT_BACKEND;
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ backendUrl, token }, null, 2));
    console.log('  Saved ✓ — you won\'t need to do this again.\n');
  }
  return { backendUrl: backendUrl || DEFAULT_BACKEND, token };
}

/** Run every portal one after another in a single block (LinkedIn → Indeed). */
async function runAll(page, api, plan, state, ctx) {
  let total = 0;
  for (const [name, fn] of [['linkedin', runLinkedIn], ['indeed', runIndeed]]) {
    if (state.paused) break;
    state.portal = name;
    await api.runStatus(state.runId, 'running', `Working ${name}`);
    await api.event({ runId: state.runId, portal: name, type: 'info', detail: `Starting ${name}` });
    try {
      const r = await fn(page, api, plan, state, ctx);
      total += r.applied || 0;
    } catch (e) {
      await api.event({ runId: state.runId, portal: name, type: 'error', detail: String(e).slice(0, 160) });
    }
  }
  return { applied: total };
}

const ADAPTERS = { linkedin: runLinkedIn, indeed: runIndeed, all: runAll };

async function main() {
  const { backendUrl, token } = await loadConfig();
  const api = new Api(backendUrl, token);

  console.log('Connecting to backend…');
  const hello = await api.hello().catch((e) => { console.error('  Auth failed:', e.message); process.exit(1); });
  console.log(`  Connected as ${hello.name || hello.userId}.`);

  const { ctx, page } = await launchBrowser();
  console.log('\n  Browser is open. Log into the portals you want to use:');
  console.log('   • LinkedIn: https://www.linkedin.com/');
  console.log('   • Indeed:   https://www.indeed.com/');
  console.log('  (log in once — the session is remembered). Then hit ▶ for a portal in the dashboard.\n');
  await page.goto('https://www.linkedin.com/').catch(() => {});

  const state = { runId: null, portal: null, action: 'Idle — waiting for a run', paused: false };
  const stopStream = startPausePoller(api, state);

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
    // Report session status often when idle so the Connections cards stay accurate (a watcher
    // in handleConnectionActions also flips a card to Active seconds after sign-in).
    if (sessionTick++ % 2 === 0) await reportSessions(ctx, api).catch(() => {});

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
    await reportSessions(ctx, api).catch(() => {}); // refresh cards right after a block
    await sleep(3000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
