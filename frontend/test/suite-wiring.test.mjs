// The render suite must stay wired in, and must stay able to fail.
//
// WHY THIS FILE EXISTS
//
// `responsive.test.mjs` is the only thing standing between a UI change and a horizontal
// scrollbar on someone's phone. It is protected by three arrangements that all look like
// incidental detail and are all load-bearing:
//
//   1. `npm test` globs `test/**/*.test.mjs`, so the suite runs because of its FILENAME.
//      Rename it to `responsive.mjs` and it silently stops running — no error, no skipped
//      count, just a green build that checks less than it used to.
//   2. `ci.yml` asserts `google-chrome --version` BEFORE `npm test`, because the suite skips
//      (rather than fails) when no browser is present. Without that assertion a runner
//      without Chrome produces a pass that proves nothing.
//   3. The suite covers every route in `ROUTES`. A page added to the router but not to that
//      list is a page nothing ever renders in a test.
//
// An earlier ADR draft claimed the suite was not in CI at all. It was — but nothing enforced
// that it STAYS in, and that is the real gap. These assertions are cheap and they fail loudly
// the moment one of the three arrangements is quietly undone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ROUTES } from './fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.resolve(here, p), 'utf8');

describe('the render suite cannot be silently unwired', () => {
  test('npm test still globs this directory, so the suite runs by filename', () => {
    const pkg = JSON.parse(read('../package.json'));
    assert.match(
      pkg.scripts.test,
      /test\/\*\*\/\*\.test\.mjs/,
      'the `test` script no longer globs test/**/*.test.mjs — responsive.test.mjs may have '
      + 'stopped running without anything reporting it',
    );
  });

  test('CI asserts a browser exists before running the suite', () => {
    const ci = read('../../.github/workflows/ci.yml');
    assert.match(
      ci,
      /google-chrome --version/,
      'ci.yml no longer checks for Chrome. The responsive suite SKIPS when no browser is '
      + 'present rather than failing, so without this check a runner without Chrome yields a '
      + 'pass that verified nothing.',
    );
    assert.match(ci, /npm test/, 'ci.yml no longer runs npm test');
  });

  test('every routed page is covered by the render suite', () => {
    const main = read('../src/main.tsx');
    // Router paths, minus the redirect-only and parameterised ones.
    const routed = [...main.matchAll(/path:\s*'([^']+)'/g)]
      .map((m) => '/' + m[1].replace(/^\//, ''))
      .filter((p) => !p.includes(':') && p !== '/agent' && p !== '/register');
    const covered = new Set(ROUTES.map(([r]) => r));
    // Sub-routes of a covered parent are exercised by that parent's entry.
    const missing = routed.filter(
      (p) => !covered.has(p) && ![...covered].some((c) => c !== '/' && p.startsWith(c + '/')),
    );
    assert.deepEqual(
      missing, [],
      `these routes exist in main.tsx but no render test visits them: ${missing.join(', ')}. `
      + 'Add them to ROUTES in fixtures.mjs — a page nothing renders is a page nothing checks.',
    );
  });
});
