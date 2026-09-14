// The page must never scroll sideways, on any screen, with real data in it.
//
// This existed as a rule in CLAUDE.md and as nothing a machine could check, so it was enforced
// by eye and it drifted. Measured, on the real app in a real browser, it caught:
//
//   Daily picks     5119px of horizontal overflow at 360 — and 4003px at 1920
//   Notifications   1123px at 360, still overflowing at every width up to 1920
//   Saved jobs       412px at 360, overflowing up to 1280
//
// All three were invisible with empty data, which is the point of the POPULATED fixture: a
// responsive check that only loads empty screens proves almost nothing. The cause in every case
// was the same — a flex item's default `min-width: auto` refusing to shrink below the intrinsic
// width of one long unbreakable string.
//
// What counts as a defect here is narrow on purpose. An element is only reported when EVERY
// ancestor up to <body> has `overflow-x: visible`, because anything else either clips it (the
// ellipsis pattern — correct) or scrolls it (a tab strip — reachable, deliberate). Reporting the
// raw rect instead flagged 272 correctly-behaving elements and buried the seven real ones.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { EMPTY, POPULATED, ROUTES } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// This suite needs a real browser. playwright-core is a devDependency of this package so the
// test is self-contained, and the browser itself is whatever Chrome the machine already has —
// no download step. If neither is present the suite SKIPS with a reason rather than failing:
// breaking the pipeline over a missing browser teaches everyone to ignore the pipeline.
let chromium = null;
let unavailable = null;
try {
  ({ chromium } = require('playwright-core'));
} catch (e) {
  unavailable = 'playwright-core not installed (run: npm ci)';
}

const PORT = 5179;
const BASE = `http://localhost:${PORT}`;
// The app's own API origin when VITE_API_BASE is unset. Routing on this ORIGIN rather than on
// any URL containing /api/ matters: the dev server serves the app's own module at
// /src/api/client.ts, and intercepting that hands React a JSON MIME type and a blank page.
const API = 'http://localhost:8080';

const WIDTHS = [[360, 740], [768, 1024], [1280, 800]];

let server;
let browser;

before(async () => {
  if (unavailable) return;
  try {
    const probe = await chromium.launch({ channel: 'chrome' });
    await probe.close();
  } catch (e) {
    unavailable = 'no Chrome available to this runner';
    return;
  }
  server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: path.resolve(here, '..'), shell: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('vite did not start in 60s')), 60000);
    server.stdout.on('data', (d) => { if (/ready in/i.test(String(d))) { clearTimeout(t); resolve(); } });
    server.on('error', reject);
  });
  browser = await chromium.launch({ channel: 'chrome' });
}, { timeout: 180000 });

after(async () => {
  await browser?.close();
  if (server && !server.killed) {
    // The shell wrapper means killing the child leaves vite itself running on Windows.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(server.pid), '/f', '/t'], { stdio: 'ignore' });
    else server.kill('SIGTERM');
  }
});

/** Render one route at one size in one theme, and measure what escapes the viewport. */
async function measure(route, [w, h], theme, fixtures) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(([t]) => {
    localStorage.setItem('jobpilot_jwt', 'test.jwt.token');
    localStorage.setItem('jobpilot_is_admin', '1');
    // initTheme() reads this at startup. The attribute cannot be set here: an init script runs
    // before the parser has created <html>.
    localStorage.setItem('jobpilot_theme', t);
  }, [theme]);
  await ctx.route(`${API}/**`, (r) => {
    const p = r.request().url().replace(API, '').split('?')[0];
    const body = Object.prototype.hasOwnProperty.call(fixtures, p) ? fixtures[p] : {};
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 140)));

  await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 25000 });
  await page.waitForTimeout(300);

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const vw = de.clientWidth;
    const cs = (el) => getComputedStyle(el);
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const st = cs(el);
      if (st.position === 'fixed' || st.opacity === '0' || st.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= 0) continue;                       // a closed off-canvas drawer
      if (el.closest('[aria-hidden="true"]')) continue;
      let contained = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (cs(a).overflowX !== 'visible') { contained = true; break; }
      }
      if (contained) continue;
      if (r.right > vw + 1) {
        if (out.some((o) => o.el.contains(el))) continue;   // outermost offender only
        out.push({ el, tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().trim().split(/\s+/)[0] || '',
          right: Math.round(r.right) });
      }
    }
    return {
      pageOverflow: de.scrollWidth - vw,
      vw,
      escaping: out.map(({ tag, cls, right }) => `<${tag}${cls ? '.' + cls : ''}> right=${right}`),
      bodyText: (document.body.innerText || '').trim().length,
    };
  });

  await ctx.close();
  return { ...m, errors };
}

function run(label, fixtures) {
  describe(label, () => {
    for (const [route, name] of ROUTES) {
      test(`${name} fits every width, both themes`, async (t) => {
        if (unavailable) return t.skip(unavailable);
        const problems = [];
        for (const theme of ['light', 'dark']) {
          for (const size of WIDTHS) {
            const r = await measure(route, size, theme, fixtures);
            const at = `${theme}@${size[0]}`;
            // A page that rendered nothing cannot overflow, so a blank result is a broken
            // fixture masquerading as a pass — fail it rather than bank the false clean.
            if (r.bodyText === 0) problems.push(`${at}: rendered NOTHING (${r.errors[0] || 'no error'})`);
            if (r.pageOverflow > 1) problems.push(`${at}: page scrolls ${r.pageOverflow}px sideways`);
            for (const e of r.escaping) problems.push(`${at}: ${e} escapes viewport ${r.vw}`);
            if (r.errors.length) problems.push(`${at}: JS error — ${r.errors[0]}`);
          }
        }
        assert.deepEqual(problems, [], `${name}:\n  ` + problems.join('\n  '));
      }, { timeout: 120000 });
    }
  });
}

run('empty state', EMPTY);
run('populated — longest values a field can hold', POPULATED);
