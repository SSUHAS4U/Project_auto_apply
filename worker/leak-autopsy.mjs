// What does a leaked application window actually COST?
//
// Every Indeed job that paused, was blocked, or hit an unanswerable question returned without
// closing the application window it had opened. One run left ~24 of them behind, plus 82 more
// jobs that took the external path. The question nobody had measured: is that a tidiness
// problem, or is it the thing killing the browser?
//
// The first measurement already reframes it — one idle Camoufox instance with a single blank
// page is ~1 GB across ~10 processes, on a 15.7 GB machine with 5 GB free. So this measures the
// slope: memory and process count per opened-and-abandoned page, which is exactly the shape of
// the leak in production.
//
// Fresh throwaway profile, local blank pages, no live sites, no owner data.
import { firefox } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const EXE = JSON.parse(fs.readFileSync(
  path.join(process.env.APPDATA, 'JobPilot', 'worker', 'browsers', 'camoufox.json'), 'utf8')).exe;

const stat = () => {
  try {
    const out = execFileSync('tasklist',
      ['/FI', 'IMAGENAME eq camoufox.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
    const rows = [...out.matchAll(/"camoufox\.exe","(\d+)"[^\n]*?"([\d,]+) K"/g)];
    return {
      procs: rows.length,
      mb: rows.reduce((s, m) => s + Number(m[2].replace(/,/g, '')), 0) / 1024,
    };
  } catch { return { procs: 0, mb: 0 }; }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-leak-'));
const ctx = await firefox.launchPersistentContext(dir, {
  executablePath: EXE, headless: true, viewport: null,
});
const base = stat();
console.log(`baseline (browser + 1 page): ${base.procs} processes, ${base.mb.toFixed(0)} MB`);

// A page with real content, because about:blank costs nothing and would understate it. This is
// roughly the weight of an application form: some markup, some script, some style.
const CONTENT = 'data:text/html,' + encodeURIComponent(`
  <html><body><h1>Apply</h1>
  ${'<div style="padding:8px;border:1px solid #ccc">field</div>'.repeat(400)}
  <script>window._x = new Array(50000).fill('application form state');</script>
  </body></html>`);

const rows = [];
for (let i = 1; i <= 12; i++) {
  const p = await ctx.newPage();               // opened and never closed — the leak
  await p.goto(CONTENT).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  const s = stat();
  rows.push({ leaked: i, ...s });
  console.log(`  ${String(i).padStart(2)} leaked window(s): `
    + `${String(s.procs).padStart(3)} processes, ${s.mb.toFixed(0).padStart(5)} MB `
    + `(+${(s.mb - base.mb).toFixed(0)} MB)`);
}

const last = rows[rows.length - 1];
const perWindow = (last.mb - base.mb) / last.leaked;
console.log(`\nper leaked window: ${perWindow.toFixed(0)} MB, `
  + `${((last.procs - base.procs) / last.leaked).toFixed(1)} processes`);

// The production shape: one run left roughly 24 windows behind on the paused path alone.
const free = 5 * 1024;
console.log(`24 leaked windows would be ~${(perWindow * 24).toFixed(0)} MB on top of the `
  + `~${base.mb.toFixed(0)} MB baseline`);
console.log(`free RAM on this machine at measurement time: ~${free} MB`);
console.log(`=> windows before free memory is gone: ~${Math.round(free / perWindow)}`);

// Now close them all and see whether the memory actually comes back — if it does not, closing
// is necessary but not sufficient and the browser still has to be recycled periodically.
for (const p of ctx.pages().slice(1)) await p.close().catch(() => {});
await new Promise((r) => setTimeout(r, 4000));
const after = stat();
console.log(`\nafter closing every leaked window: ${after.procs} processes, `
  + `${after.mb.toFixed(0)} MB (baseline was ${base.mb.toFixed(0)} MB)`);
console.log(after.mb <= base.mb * 1.35
  ? 'memory RETURNS on close — closing the window is a real fix'
  : 'memory does NOT fully return — closing helps but the browser also needs recycling');

await ctx.close();
fs.rmSync(dir, { recursive: true, force: true });
