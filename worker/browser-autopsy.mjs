// Does Camoufox die on its own? Reproduce it here instead of theorising about it.
//
// Two questions have been answered with guesses for two days:
//   1. why does launchPersistentContext fail right after we kill the strays?
//   2. what kills the browser 20-60 minutes in, sometimes while completely idle?
//
// Nothing here touches the owner's profile or any live site. Fresh throwaway profiles, local
// about:blank pages only. Browser stability has nothing to do with which cookies are loaded.
import { firefox } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const EXE = JSON.parse(fs.readFileSync(
  path.join(process.env.APPDATA, 'JobPilot', 'worker', 'browsers', 'camoufox.json'), 'utf8')).exe;
const t = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(`[${t()}]`, ...a);

const pids = () => {
  try {
    const out = execFileSync('tasklist',
      ['/FI', 'IMAGENAME eq camoufox.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
    return [...out.matchAll(/"camoufox\.exe","(\d+)"/gi)].map((m) => Number(m[1]));
  } catch { return []; }
};
const memMB = () => {
  try {
    const out = execFileSync('tasklist',
      ['/FI', 'IMAGENAME eq camoufox.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
    return [...out.matchAll(/"([\d,]+) K"/g)]
      .reduce((s, m) => s + Number(m[1].replace(/,/g, '')), 0) / 1024;
  } catch { return 0; }
};

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jp-autopsy-'));

// ── EXPERIMENT 1 ────────────────────────────────────────────────────────────
// Kill every camoufox, then relaunch immediately — the exact sequence that fails at startup.
// If the profile lock is the cause, a relaunch on the SAME directory fails and a relaunch on a
// fresh one succeeds. That distinguishes "the lock" from "the browser is simply broken".
async function experiment1() {
  say('EXPERIMENT 1 — relaunch straight after a kill');
  const dir = fresh();
  const a = await firefox.launchPersistentContext(dir, { executablePath: EXE, headless: true, viewport: null });
  say(`  launched, pids: ${pids().join(',')}`);
  try { execFileSync('taskkill', ['/F', '/IM', 'camoufox.exe', '/T'], { stdio: 'ignore' }); } catch { /* none */ }
  say('  taskkill issued (returns immediately — this is the point)');
  for (const waitMs of [0, 1000, 3000]) {
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    const live = pids();
    try {
      const b = await firefox.launchPersistentContext(dir, { executablePath: EXE, headless: true, viewport: null });
      say(`  +${waitMs}ms  survivors=${live.length}  ->  RELAUNCH OK`);
      await b.close();
      break;
    } catch (e) {
      say(`  +${waitMs}ms  survivors=${live.length}  ->  FAILED: ${String(e.message).slice(0, 70)}`);
    }
  }
  try { await a.close(); } catch { /* already dead */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── EXPERIMENT 2 ────────────────────────────────────────────────────────────
// Leave it idle and watch. One context is pinged every 30s (what the new heartbeat does), the
// other is left completely alone. If only the untouched one dies, idleness is the cause and the
// heartbeat is the fix. If both die, it is time-based and the heartbeat only reports it. If
// neither dies, nothing about the browser is killing it and the cause is in the worker.
async function experiment2(minutes) {
  say(`EXPERIMENT 2 — idle for ${minutes} minutes, one pinged and one not`);
  const dirs = [fresh(), fresh()];
  const ctxs = [];
  for (const d of dirs) {
    const c = await firefox.launchPersistentContext(d, { executablePath: EXE, headless: true, viewport: null });
    const p = c.pages()[0] || await c.newPage();
    await p.goto('about:blank').catch(() => {});
    let dead = null;
    c.on('close', () => { dead = dead || `context closed at ${t()}`; });
    p.on('crash', () => { dead = dead || `page crashed at ${t()}`; });
    ctxs.push({ c, p, dead: () => dead, set: (v) => { dead = dead || v; } });
  }
  say(`  two browsers up, ${pids().length} processes, ${memMB().toFixed(0)} MB total`);

  const until = Date.now() + minutes * 60_000;
  let i = 0;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 30_000));
    i++;
    // [0] is pinged. [1] is deliberately untouched until the very end.
    try { await ctxs[0].p.evaluate(() => 1); } catch (e) { ctxs[0].set(`ping failed: ${String(e.message).slice(0, 60)}`); }
    say(`  +${i * 0.5}min  processes=${pids().length}  mem=${memMB().toFixed(0)}MB  `
      + `pinged=${ctxs[0].dead() || 'alive'}  untouched=${ctxs[1].dead() || '(not probed)'}`);
    if (ctxs[0].dead()) break;
  }

  // Now probe the untouched one — the first thing that touches it in `minutes` minutes.
  try {
    await ctxs[1].p.evaluate(() => 1);
    say(`  untouched browser after ${minutes}min: ALIVE`);
  } catch (e) {
    say(`  untouched browser after ${minutes}min: DEAD — ${String(e.message).slice(0, 80)}`);
  }
  say(`  pinged browser: ${ctxs[0].dead() || 'ALIVE'}`);

  for (const { c } of ctxs) { try { await c.close(); } catch { /* gone */ } }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

say(`camoufox: ${EXE}`);
await experiment1();
await experiment2(Number(process.argv[2] || 12));
try { execFileSync('taskkill', ['/F', '/IM', 'camoufox.exe', '/T'], { stdio: 'ignore' }); } catch { /* none */ }
say('done');
