// Which resume the PORTAL attached — read, never uploaded.
//
// The bug this replaces: JobPilot pushed its own copy of the CV into the form and then waited
// for the portal to echo OUR filename back. LinkedIn and Indeed arrive with the member's own
// saved resume already selected and never echo anything of ours, so the confirmation could not
// arrive in the normal case. Every application paused on "the resume did not finish uploading"
// while the correct resume sat attached on screen.
//
// These fixtures are the real markup shapes, not a convenient simplification: LinkedIn's
// file-name card, LinkedIn's radio list where a NON-first resume is the checked one, Indeed's
// hosted resume that has no filename at all, and a form with nothing. Live portals cannot be
// driven from here, so the mock is the closest faithful thing — and the radio case is included
// precisely because reading the first label instead of the checked one would report the wrong
// file with total confidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { observeResume } from '../src/fill.js';
import { findChrome } from './harness.mjs';

const chrome = findChrome();

async function onPage(html, fn) {
  const b = await chromium.launch({ executablePath: chrome });
  const p = await b.newPage();
  await p.setContent(`<!doctype html><body>${html}</body>`);
  try { return await fn(p); } finally { await b.close(); }
}

test('LinkedIn: the filename card is read as the attached resume', { skip: !chrome && 'no Chrome' }, async () => {
  const r = await onPage(`
    <div class="jobs-document-upload-redesign-card__container">
      <h3 class="jobs-document-upload-redesign-card__file-name">Suhas_Backend_2026.pdf</h3>
      <div class="jobs-document-upload-redesign-card__file-info">Uploaded on 12/08/2026</div>
    </div>`, (p) => observeResume(p));
  assert.equal(r.attached, true);
  assert.equal(r.name, 'Suhas_Backend_2026.pdf');
});

test('LinkedIn: the CHECKED resume wins, not the first one listed', { skip: !chrome && 'no Chrome' }, async () => {
  // The one that gets sent is the selected one. Reading the first label would name
  // Old_Resume_2019.pdf while the employer receives Suhas_Backend_2026.pdf — a wrong answer
  // stated confidently, which is worse than no answer.
  const r = await onPage(`
    <div>
      <label><input type="radio" name="cv"> Old_Resume_2019.pdf</label>
      <label><input type="radio" name="cv" checked> Suhas_Backend_2026.pdf</label>
    </div>`, (p) => observeResume(p));
  assert.equal(r.name, 'Suhas_Backend_2026.pdf', 'named the unchecked resume');
});

test('Indeed: the hosted resume has no filename and still counts as attached',
  { skip: !chrome && 'no Chrome' }, async () => {
    // Reporting "none" here would be wrong — there IS a resume, it just is not a file.
    const r = await onPage('<div><h2>Resume</h2><p>Your Indeed Resume will be sent.</p></div>',
      (p) => observeResume(p));
    assert.equal(r.attached, true);
    assert.equal(r.name, 'Indeed Resume');
  });

test('a .docx resume is recognised, not only .pdf', { skip: !chrome && 'no Chrome' }, async () => {
  const r = await onPage('<div class="file-name">My CV (final).docx</div>', (p) => observeResume(p));
  assert.equal(r.name, 'My CV (final).docx');
});

test('nothing visible reports none — and does NOT throw or block',
  { skip: !chrome && 'no Chrome' }, async () => {
    // The whole point: an unreadable form must not stop the application. The portal validates
    // its own submit.
    const r = await onPage('<form><input name="phone"><button>Submit</button></form>',
      (p) => observeResume(p));
    assert.equal(r.attached, false);
    assert.equal(r.name, null);
  });

test('a company name ending in a dot is not mistaken for a filename',
  { skip: !chrome && 'no Chrome' }, async () => {
    // "Acme Inc." near the word resume must not be reported as the attachment. Only a real
    // document extension counts.
    const r = await onPage('<div><p>Acme Inc. is hiring. Attach a resume to continue.</p></div>',
      (p) => observeResume(p));
    assert.equal(r.name, null, 'matched prose as a filename');
  });

test('the resume is never uploaded — observeResume touches no file input',
  { skip: !chrome && 'no Chrome' }, async () => {
    // The regression guard for the actual complaint. If anything ever re-adds setInputFiles,
    // the input below will hold a file and this fails.
    const files = await onPage('<input type="file" id="f"><div class="file-name">Theirs.pdf</div>',
      async (p) => {
        await observeResume(p);
        return p.evaluate(() => document.querySelector('#f').files.length);
      });
    assert.equal(files, 0, 'observeResume uploaded a file');
  });
