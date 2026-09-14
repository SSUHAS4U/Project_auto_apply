// The form engine, driven in a real Chrome against real ATS DOM shapes.
//
// A real browser rather than a DOM mock, deliberately: the engine's whole job is to survive
// shadow roots, same-origin iframes, computed-style visibility, framework-controlled inputs and
// click-through labels. Every one of those is a browser behaviour a mock would let us fake, and
// faking them is how the previous engine came to be believed correct while failing on real sites.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as F from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve(here, '../../worker/node_modules/playwright-core'));

const SCRIPTS = ['smartFill.js', 'formEngine.js']
  .map((f) => path.resolve(here, '../content/common', f));

let browser;
let page;

before(async () => {
  browser = await chromium.launch({ channel: 'chrome' });
  page = await browser.newPage();
});
after(async () => { await browser?.close(); });

/** Load a fixture and inject the engine. Returns the page. */
async function load(html) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><body>${html}</body>`);
  for (const p of SCRIPTS) await page.addScriptTag({ path: p });
  return page;
}

/** The collected fields, reduced to what a test cares about. */
function collect() {
  return page.evaluate(() => window.JobPilotForm.collect().map((f) => ({
    id: f.id, kind: f.kind, label: f.label, confidence: f.confidence,
    source: f.labelSource, options: f.options, required: f.required, value: f.value,
  })));
}

describe('labelling', () => {
  test('a section heading is never handed to the fields beneath it', async () => {
    await load(F.sharedLabel);
    const fields = await collect();
    assert.equal(fields.length, 3);
    const labels = fields.map((f) => f.label);
    assert.deepEqual(labels, ['School Name', 'Board', 'Percentage']);
    // The exact regression: three fields must not share one label.
    assert.equal(new Set(labels).size, 3);
    assert.ok(!labels.some((l) => /ACADEMIC DETAILS/i.test(l)),
      'the section heading leaked into a field label: ' + JSON.stringify(labels));
  });

  test('Microsoft Forms: the title span wins over the generic aria-label', async () => {
    await load(F.msForms);
    const fields = await collect();
    assert.deepEqual(fields.map((f) => f.label), ['What is your full name?', 'Your Email ID']);
    assert.ok(!fields.some((f) => /enter your answer/i.test(f.label)));
  });

  test('Google Forms: role=heading titles, and the radio group is ONE field', async () => {
    await load(F.googleForms);
    const fields = await collect();
    assert.equal(fields.length, 2, 'two questions, not one textarea plus two radios');
    const ta = fields.find((f) => f.kind === 'textarea');
    const radio = fields.find((f) => f.kind === 'radio');
    assert.equal(ta.label, 'Why do you want this role?');
    assert.equal(radio.label, 'Are you willing to relocate?');
    assert.deepEqual(radio.options, ['Yes', 'No']);
  });

  test('Workday: aria-labelledby, and the typeahead is classified as a combobox', async () => {
    await load(F.workday);
    const fields = await collect();
    assert.deepEqual(fields.map((f) => f.label),
      ['First Name', 'Last Name', 'Country', 'Email Address']);
    assert.equal(fields.find((f) => f.label === 'Country').kind, 'combobox',
      'a typeahead written to as plain text leaves the widget state unset');
    assert.equal(fields.find((f) => f.label === 'Email Address').required, true);
  });

  test('table grid: the label comes from the column and row headers', async () => {
    await load(F.grid);
    const fields = await collect();
    assert.equal(fields.length, 2);
    assert.match(fields[0].label, /Institute/);
    assert.match(fields[1].label, /Year of Passing/);
    assert.notEqual(fields[0].label, fields[1].label);
  });

  test('a label that cannot be derived reports low confidence rather than a wrong answer', async () => {
    await load('<input name="field_9702_1_1" />');
    const [f] = await collect();
    // JUNK_NAME rejects the machine name; nothing else is available.
    assert.equal(f.label, '');
    assert.equal(f.confidence, 0);
  });
});

describe('collection reach', () => {
  test('finds controls inside an open shadow root', async () => {
    await load(F.shadow);
    const fields = await collect();
    assert.equal(fields.length, 1);
    assert.equal(fields[0].label, 'LinkedIn Profile');
  });

  test('finds controls inside a same-origin iframe', async () => {
    await load(F.iframeForm);
    const fields = await collect();
    assert.deepEqual(fields.map((f) => f.label).sort(), ['Email', 'Full name']);
  });

  test('a position:fixed field is visible; a display:none one is not', async () => {
    await load(F.controls);
    const fields = await collect();
    const labels = fields.map((f) => f.label);
    // offsetParent is null for position:fixed — the old visibility test skipped these.
    assert.ok(labels.includes('Phone'), 'position:fixed field was skipped: ' + JSON.stringify(labels));
    assert.ok(!labels.includes('Hidden field'), 'a display:none field was collected');
  });

  test('every control kind is classified, and groups collapse to one field each', async () => {
    await load(F.controls);
    const fields = await collect();
    const byKind = Object.fromEntries(fields.map((f) => [f.kind, f]));
    assert.ok(byKind.select && byKind.radio && byKind.checkbox && byKind.date
      && byKind.contenteditable && byKind.tel, 'missing kinds: ' + JSON.stringify(fields.map((f) => f.kind)));
    assert.deepEqual(byKind.checkbox.options, ['Java', 'Python', 'Go']);
    assert.equal(byKind.checkbox.label, 'Which languages do you know?');
    // "Please select" is a prompt, not a choice.
    assert.deepEqual(byKind.select.options, ['Bachelors', 'Masters']);
  });
});

describe('writers', () => {
  /** Write a value into the field whose label matches, then read back what the DOM holds. */
  async function writeTo(label, value) {
    return page.evaluate(async ([lab, val]) => {
      const f = window.JobPilotForm.collect().find((x) => x.label === lab);
      if (!f) return { ok: false, err: 'field not found' };
      const ok = await window.JobPilotForm.write(f, val);
      const after = window.JobPilotForm.collect().find((x) => x.label === lab);
      return { ok, value: after ? after.value : null };
    }, [label, value]);
  }

  test('select picks the option by visible text', async () => {
    await load(F.controls);
    const r = await writeTo('Highest Qualification', 'Masters');
    assert.equal(r.ok, true);
    assert.equal(r.value, 'Masters');
  });

  test('radio ticks the matching choice', async () => {
    await load(F.controls);
    const r = await writeTo('Do you require visa sponsorship?', 'No');
    assert.equal(r.ok, true);
    assert.match(r.value, /No/);
  });

  test('checkbox takes several comma-separated answers', async () => {
    await load(F.controls);
    const r = await writeTo('Which languages do you know?', 'Java, Go');
    assert.equal(r.ok, true);
    assert.match(r.value, /Java/);
    assert.match(r.value, /Go/);
    assert.ok(!/Python/.test(r.value), 'ticked an option that was not asked for');
  });

  test('date normalises to the yyyy-mm-dd an input[type=date] accepts', async () => {
    await load(F.controls);
    const r = await writeTo('Available from', '15/03/2027');
    assert.equal(r.ok, true);
    assert.equal(r.value, '2027-03-15');
  });

  test('contenteditable takes text', async () => {
    await load(F.controls);
    const r = await writeTo('Cover note', 'Happy to start immediately.');
    assert.equal(r.ok, true);
    assert.equal(r.value, 'Happy to start immediately.');
  });

  test('a framework-controlled input sees the change', async () => {
    await load(F.controlled);
    const r = await writeTo('Current Company', 'Acme Corp');
    assert.equal(r.ok, true);
    // The listener fired, i.e. the native setter was used rather than a bare assignment —
    // which is the difference between the form accepting the value and silently dropping it.
    assert.equal(await page.evaluate(() => window.__reactSaw), 'Acme Corp');
  });

  test('a value that matches no option is refused rather than forced', async () => {
    await load(F.controls);
    const r = await writeTo('Highest Qualification', 'Doctorate');
    assert.equal(r.ok, false, 'writing an absent option would submit a wrong answer');
    assert.equal(r.value, '');
  });

  test('an empty answer writes nothing', async () => {
    await load(F.controls);
    const r = await writeTo('Cover note', '');
    assert.equal(r.ok, false);
  });
});

describe('date parsing', () => {
  test('accepts the formats forms actually produce', async () => {
    await load('<input />');
    const got = await page.evaluate(() => ['2027-03-15', '15/03/2027', '15-03-2027', 'March 15, 2027', 'nonsense']
      .map((s) => window.JobPilotForm.toIsoDate(s)));
    assert.deepEqual(got, ['2027-03-15', '2027-03-15', '2027-03-15', '2027-03-15', '']);
  });
});
