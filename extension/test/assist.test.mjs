// The ✨ pill and its question derivation, in a real Chrome on a real (fake) hostname.
//
// Two things are being pinned here, and both were user-visible failures:
//
//  1. The pill appeared only on hostnames matching an ALLOW_HOSTS regex, so a company careers
//     page on its own domain — the common case — offered nothing at all.
//  2. deriveQuestion ended in `el.closest('div')` + "first heading inside", so a wrapper holding
//     several fields gave every one of them the same label. That is "the AI answer doesn't read
//     the question properly, sometimes".
//
// The page is served on a hostname that was NOT in the old allow-list, on purpose.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as F from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve(here, '../../worker/node_modules/playwright-core'));

// The full content-script set, READ FROM manifest.json so it can't drift: a hand-copied list
// here missed jpUi.js when it was added, and every pill test failed on a missing global.
const MANIFEST = JSON.parse(readFileSync(path.resolve(here, '../manifest.json'), 'utf8'));
const SCRIPTS = MANIFEST.content_scripts[0].js.map((f) => path.resolve(here, '..', f));

// Minimal MV3 surface. The engines call these at load; nothing here reaches a network.
const CHROME_STUB = `
window.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    sendMessage(_m, cb) { if (cb) cb({ ok: false, error: 'stubbed' }); },
    lastError: null,
  },
  storage: {
    local: { get(_d, cb) { if (cb) cb({ jobpilotEnabled: true }); }, set() {} },
    onChanged: { addListener() {} },
  },
};`;

let browser;
let page;

before(async () => {
  // Safe-browsing adds a ~30s lookup for any hostname containing a well-known brand, and one
  // of these fixtures deliberately uses a deny-listed name. Nothing here reaches the network.
  browser = await chromium.launch({
    channel: 'chrome',
    args: ['--disable-features=SafeBrowsing', '--disable-client-side-phishing-detection'],
  });
  page = await browser.newPage();
  // Serve every request for this host from memory, so location.hostname is a real careers
  // domain rather than about:blank — which is the whole point of the allow-list test.
  await page.route('**/*', (route) => route.fulfill({
    status: 200, contentType: 'text/html', body: page.__html || '<html><body></body></html>',
  }));
});
after(async () => { await browser?.close(); });

async function loadOn(url, html) {
  page.__html = `<!doctype html><meta charset="utf-8"><body>${html}</body>`;
  await page.goto(url);
  await page.addScriptTag({ content: CHROME_STUB });
  for (const p of SCRIPTS) await page.addScriptTag({ path: p });
  await page.waitForFunction(() => !!window.JobPilotAssist);
}

/** The hostname a careers page actually lives on — not an ATS the old regex knew about. */
const CAREERS = 'https://careers.example-corp.test/openings/backend-engineer';

describe('question derivation', () => {
  test('sibling fields under one heading get their OWN questions', async () => {
    await loadOn(CAREERS, F.sharedLabel);
    const qs = await page.evaluate(() => ['a1', 'a2', 'a3']
      .map((id) => window.JobPilotAssist.deriveQuestion(document.getElementById(id))));
    assert.deepEqual(qs, ['School Name', 'Board', 'Percentage']);
    assert.equal(new Set(qs).size, 3, 'three fields were handed the same question');
    assert.ok(!qs.some((q) => /ACADEMIC DETAILS/i.test(q)),
      'the section heading was returned as a field question: ' + JSON.stringify(qs));
  });

  test('Microsoft Forms: the real title, not "Enter your answer"', async () => {
    await loadOn(CAREERS, F.msForms);
    const qs = await page.evaluate(() => [...document.querySelectorAll('input')]
      .map((el) => window.JobPilotAssist.deriveQuestion(el)));
    assert.deepEqual(qs, ['What is your full name?', 'Your Email ID']);
  });

  test('an unreadable machine name yields no question rather than a wrong one', async () => {
    // Two controls under the heading, so it belongs to the SECTION and to neither field.
    // (A heading in a block holding exactly one control is that control's label — the shape
    // Google Forms uses — and is covered by the role=listitem test.)
    await loadOn(CAREERS,
      '<form><h2>Section B</h2>'
      + '<div><input name="field_9702_1_1" /></div>'
      + '<div><input name="q_17" /></div></form>');
    const qs = await page.evaluate(() => [...document.querySelectorAll('input')]
      .map((el) => window.JobPilotAssist.deriveQuestion(el)));
    // Both machine names are rejected as labels, and the section heading is out of scope for
    // both. '' sends the surroundings to the backend, which is recoverable; "Section B" on two
    // different fields is not.
    assert.deepEqual(qs, ['', '']);
  });
});

describe('where the pill is offered', () => {
  /** Focus the selector and report whether the pill attached itself. */
  async function pillAppears(selector) {
    await page.focus(selector);
    try {
      // The signature is (fn, arg, options) — passing the options object in the ARG slot
      // silently leaves the default 30s timeout in place, which is what made the negative
      // case take thirty seconds to conclude "no".
      await page.waitForFunction(() => {
        const p = document.getElementById('jobpilot-pill');
        return !!p && p.style.display !== 'none';
      }, undefined, { timeout: 1500 });
      return true;
    } catch (_) {
      return false;
    }
  }

  test('appears on a careers domain that was never in the allow-list', async () => {
    await loadOn(CAREERS, F.sharedLabel);
    assert.equal(await pillAppears('#a1'), true,
      'the pill is gated by hostname again — a company careers page gets nothing');
  });

  test('appears on a bare domain with no job words in the URL at all', async () => {
    // The old fallback also demanded /apply|career|job|…/ in the URL or title.
    await loadOn('https://portal.example.test/p/17', F.msForms);
    assert.equal(await pillAppears('input'), true);
  });

  test('stays out of the sites where it would only be noise', async () => {
    await loadOn('https://chatgpt.com.example.test/', '<textarea id="t"></textarea>');
    assert.equal(await pillAppears('#t'), false,
      'the deny-list is what keeps the pill out of chat apps');
  });

  test('a field inside a position:fixed panel still offers the pill', async () => {
    await loadOn(CAREERS,
      '<div style="position:fixed;top:0"><label for="p1">Why this role?</label>'
      + '<textarea id="p1"></textarea></div>');
    // offsetParent is null here, which is what used to refuse the pill.
    assert.equal(await pillAppears('#p1'), true);
  });
});
