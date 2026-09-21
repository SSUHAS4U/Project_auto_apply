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
  // Vite runs IN THIS PROCESS via its own API rather than as a spawned command.
  //
  // The spawned version hung four CI runs, the longest for five hours: `shell: true` made the
  // child a /bin/sh wrapper, so killing it left vite alive, holding the port and an open stdio
  // pipe, and `node --test` could never exit. A hung pipeline is worse than the missing check
  // this suite exists to provide. In-process there is nothing to orphan and close() is exact.
  const { createServer } = await import('vite');
  server = await createServer({
    root: path.resolve(here, '..'),
    logLevel: 'error',
    server: { port: PORT, strictPort: true },
  });
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome' });
}, { timeout: 180000 });

after(async () => {
  await browser?.close();
  await server?.close();
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
  const unmapped = new Set();
  await ctx.route(`${API}/**`, (r) => {
    const p = r.request().url().replace(API, '').split('?')[0];
    const known = Object.prototype.hasOwnProperty.call(fixtures, p);
    // An endpoint with no fixture used to get `{}`. That is a guess, and a wrong guess breaks
    // the page in a way that looks like anything BUT a missing fixture: `.find is not a
    // function` surfacing as Vite's error overlay, whose <pre> then reads as a layout defect.
    // Record it and fail the test by name instead.
    if (!known && r.request().method() === 'GET') unmapped.add(p);
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(known ? fixtures[p] : {}),
    });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 140)));

  await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 25000 });
  await page.waitForTimeout(300);

  const m = await page.evaluate(MEASURE_FN);
  await ctx.close();
  return { ...m, errors, unmapped: [...unmapped] };
}

/** Runs inside the page. Shared by both passes so they cannot drift apart. */
const MEASURE_FN = () => {
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
    // An overlay taller than the viewport with nothing scrollable in it strands its own
    // buttons off-screen — the vertical twin of horizontal overflow.
    const trapped = [];
    for (const ov of document.querySelectorAll('.modal, .drawer, [role="dialog"]')) {
      const r = ov.getBoundingClientRect();
      if (r.height <= de.clientHeight + 2) continue;
      const own = cs(ov).overflowY;
      if (own === 'auto' || own === 'scroll') continue;
      const inner = [...ov.querySelectorAll('*')].some((c) => {
        const o = cs(c).overflowY;
        return (o === 'auto' || o === 'scroll') && c.scrollHeight > c.clientHeight;
      });
      if (!inner) trapped.push(`${(ov.className || '').toString().split(/\s+/)[0] || ov.tagName} is ${Math.round(r.height)}px tall in a ${de.clientHeight}px viewport`);
    }

    return {
      pageOverflow: de.scrollWidth - vw,
      vw,
      escaping: out.map(({ tag, cls, right }) => `<${tag}${cls ? '.' + cls : ''}> right=${right}`),
      trapped,
      bodyText: (document.body.innerText || '').trim().length,
    };
};

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
            for (const u of r.unmapped) problems.push(`${at}: no fixture for ${u} — add it to fixtures.mjs`);
          }
        }
        assert.deepEqual(problems, [], `${name}:\n  ` + problems.join('\n  '));
      }, { timeout: 120000 });
    }
  });
}

run('empty state', EMPTY);
run('populated — longest values a field can hold', POPULATED);

/**
 * One job card, everywhere a job is shown.
 *
 * The board, Daily picks and Scout already shared JobCardV2. Saved jobs had its own card and
 * the tracker had a desktop TABLE plus a separate mobile card — and those two had already
 * drifted: the mobile one showed a bare score chip where the board showed a fit panel. That is
 * the failure this asserts against. Without a test, "they all use the same card" is a claim
 * that decays the first time someone is in a hurry.
 */
describe('one job card on every job surface', () => {
  const CARD_SURFACES = [
    ['/jobs', 'Job board'],
    ['/daily', 'Daily picks'],
    ['/scout', 'Scout'],
    ['/applications', 'Applications'],
    ['/saved', 'Saved jobs'],
  ];

  for (const [route, name] of CARD_SURFACES) {
    test(`${name} renders the shared card`, async (t) => {
      if (unavailable) return t.skip(unavailable);
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(() => {
        localStorage.setItem('jobpilot_jwt', 'test.jwt.token');
        localStorage.setItem('jobpilot_is_admin', '1');
        localStorage.setItem('jobpilot_theme', 'light');
        // Both card-capable surfaces default to cards; be explicit so a stale preference in
        // a future harness cannot silently turn this into a table test that always passes.
        localStorage.setItem('jobpilot_jobs_view', 'cards');
        localStorage.setItem('jobpilot_apps_view', 'cards');
      });
      await ctx.route(`${API}/**`, (r) => {
        const p = r.request().url().replace(API, '').split('?')[0];
        const known = Object.prototype.hasOwnProperty.call(POPULATED, p);
        return r.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify(known ? POPULATED[p] : {}),
        });
      });
      const page = await ctx.newPage();
      await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 25000 });
      await page.waitForTimeout(300);
      const cards = await page.locator('.jc2').count();
      await ctx.close();
      assert.ok(cards > 0, `${name} (${route}) rendered ${cards} .jc2 cards — it is not using the shared job card`);
    }, { timeout: 120000 });
  }

  /**
   * A fact a posting doesn't state is LEFT OUT, on every card (agreed in the 2026-09-21
   * redesign). Four cells of "Not mentioned" read as a broken card; a shorter card says the same
   * thing honestly. A listing with no facts at all drops the facts row entirely.
   */
  test('no card prints "Not mentioned"; a card with no facts drops the row', async (t) => {
    if (unavailable) return t.skip(unavailable);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => {
      localStorage.setItem('jobpilot_jwt', 'test.jwt.token');
      localStorage.setItem('jobpilot_is_admin', '1');
      localStorage.setItem('jobpilot_theme', 'light');
    });
    await ctx.route(`${API}/**`, (r) => {
      const p = r.request().url().replace(API, '').split('?')[0];
      const known = Object.prototype.hasOwnProperty.call(POPULATED, p);
      return r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(known ? POPULATED[p] : {}),
      });
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/saved', { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(300);

    // The fixture mixes a row WITH a description (modern) and one without (legacy). Neither may
    // say "Not mentioned"; the modern one must still show the facts it does have.
    const cards = await page.locator('.jc2').count();
    const notMentioned = await page.locator('.jc2', { hasText: 'Not mentioned' }).count();

    const legacy = page.locator('.jc2', { hasText: 'Single Position' }).first();
    const legacyMeta = await legacy.locator('.jc2-meta').count();

    const modern = page.locator('.jc2').first();
    const modernFacts = await modern.locator('.jc2-meta span').count();
    const modernFit = await modern.locator('.fit').count();
    await ctx.close();

    assert.ok(cards >= 6, `expected the mixed fixture to render at least 6 cards, got ${cards}`);
    assert.equal(notMentioned, 0, `${notMentioned} card(s) printed "Not mentioned" — an unstated fact is omitted`);
    assert.equal(legacyMeta, 0,
      'a saved job with no facts at all must drop the meta row entirely, not leave an empty one');
    assert.ok(modernFacts > 0, 'a saved job WITH a description must still show its facts');
    assert.equal(modernFit, 1, 'a scored saved job must show the same fit scale as the board');
  }, { timeout: 120000 });
});

/**
 * Where the job surfaces live in the menu.
 *
 * Cheap, and it catches a NAV edit that half-lands — the sidebar and the dock derive from the
 * same array, so a wrong edit moves both and neither complains.
 */
describe('navigation groups the job surfaces', () => {
  test('Applications is inside Jobs, not a top-level module', async (t) => {
    if (unavailable) return t.skip(unavailable);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => {
      localStorage.setItem('jobpilot_jwt', 'test.jwt.token');
      localStorage.setItem('jobpilot_is_admin', '1');
      localStorage.setItem('jobpilot_theme', 'light');
      localStorage.setItem('jobpilot_rail', '0');
    });
    await ctx.route(`${API}/**`, (r) => {
      const p = r.request().url().replace(API, '').split('?')[0];
      const known = Object.prototype.hasOwnProperty.call(POPULATED, p);
      return r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(known ? POPULATED[p] : {}),
      });
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/jobs', { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(400);

    const topLevel = await page.locator('.sidebar .nav-parent').allInnerTexts();
    const dock = await page.locator('.dock .dock-item').evaluateAll(
      (els) => els.map((e) => e.getAttribute('aria-label')));
    await ctx.close();

    const tops = topLevel.map((t2) => t2.trim());
    assert.ok(!tops.includes('Applications'),
      `"Applications" is still a top-level module: ${JSON.stringify(tops)}`);
    assert.deepEqual(dock, ['Job board', 'Daily picks', 'Scout', 'Applications', 'Saved jobs'],
      `Jobs dock is in the wrong order or missing an entry: ${JSON.stringify(dock)}`);
  }, { timeout: 120000 });
});

/**
 * The states a page only reaches once you touch it.
 *
 * A resting-state check misses everything behind an interaction, and those are the states that
 * matter most on a phone: the drawer is the only navigation there, and a tab panel can hold
 * content the default panel does not. Run at 360 — the width where an overlay has the least
 * room and therefore the most to go wrong.
 *
 * This pass also watches for an overlay TALLER than the viewport with nothing to scroll it,
 * which strands its own buttons off-screen: the vertical twin of the overflow bug this file
 * was written for, and just as unusable.
 */
describe('interactive states at 360', () => {
  for (const [route, name] of ROUTES) {
    test(`${name}: drawer and tab panels fit`, async (t) => {
      if (unavailable) return t.skip(unavailable);
      const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
      await ctx.addInitScript(() => {
        localStorage.setItem('jobpilot_jwt', 'test.jwt.token');
        localStorage.setItem('jobpilot_is_admin', '1');
        localStorage.setItem('jobpilot_theme', 'light');
      });
      await ctx.route(`${API}/**`, (r) => {
        const p = r.request().url().replace(API, '').split('?')[0];
        const known = Object.prototype.hasOwnProperty.call(POPULATED, p);
        return r.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify(known ? POPULATED[p] : {}),
        });
      });
      const page = await ctx.newPage();
      const problems = [];
      // Vite renders a runtime error as an overlay rather than throwing to the page, so without
      // this the error surfaces only as that overlay's <pre> — which then reads as a layout
      // defect instead of the broken fixture it actually is.
      page.on('pageerror', (e) => problems.push('JS error — ' + String(e.message).slice(0, 120)));

      try {
        await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 25000 });
        await page.waitForTimeout(250);

        const check = async (state) => {
          const m = await page.evaluate(MEASURE_FN);
          if (m.pageOverflow > 1) problems.push(`${state}: page scrolls ${m.pageOverflow}px sideways`);
          for (const e of m.escaping) problems.push(`${state}: ${e}`);
          for (const x of m.trapped) problems.push(`${state}: unscrollable overlay ${x}`);
        };

        const burger = page.locator('.hamburger');
        if (await burger.count() && await burger.first().isVisible()) {
          await burger.first().click();
          await page.waitForTimeout(320);
          await check('drawer open');
          await page.keyboard.press('Escape');
          const scrim = page.locator('.scrim');
          if (await scrim.count()) await scrim.first().click({ force: true }).catch(() => {});
          await page.waitForTimeout(200);
        }

        const tabs = page.locator('.tab, .pf-nav-item');
        const n = Math.min(await tabs.count(), 6);
        for (let i = 0; i < n; i++) {
          const tab = tabs.nth(i);
          if (!(await tab.isVisible().catch(() => false))) continue;
          const label = ((await tab.innerText().catch(() => '')) || '').trim().slice(0, 20);
          await tab.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(260);
          await check(`tab "${label}"`);
        }
      } finally {
        await ctx.close();
      }
      assert.deepEqual(problems, [], `${name} at 360:\n  ` + problems.join('\n  '));
    }, { timeout: 120000 });
  }
});
