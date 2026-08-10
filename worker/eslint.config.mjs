// The check that would have caught the last four production bugs.
//
// Three consecutive releases shipped the same fault: code referencing a variable that belongs
// to a DIFFERENT function's scope. Each was valid JavaScript, so `node --check` passed. Each
// reached the owner's machine. Each broke something real:
//
//   · `_verdict` — post scan and recruiter emails died on their first line, two flows dead for
//     a day, because a scripted edit wrapped returns in functions where the helper did not exist
//   · `ctx`      — emailFromProfile called with a variable scanHiringPosts never receives
//   · `title`    — 38 applications FAILED in one run; the guard added to protect an application
//     from submitting without a CV is what destroyed it
//
// A fourth (`fs`, `path`, `APP_DIR` missing from indeed.js) was caught only by loading the
// module instead of parsing it. `no-undef` finds all of them in under a second.
//
// This config is deliberately narrow. It is not a style opinion and it will not argue about
// quotes or semicolons — every rule here corresponds to a bug that actually shipped. A linter
// that reports 400 cosmetic complaints gets ignored, and then it catches nothing at all.
export default [
  {
    files: ['src/**/*.js', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // Node
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        __dirname: 'readonly',
        // Browser globals, for the bodies of page.evaluate() callbacks. These run inside the
        // page, not in Node — without declaring them every DOM call is a false `no-undef` and
        // the real ones drown.
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        getComputedStyle: 'readonly',
        CSS: 'readonly',
        Node: 'readonly',
        HTMLElement: 'readonly',
        // (page-context helpers used inside evaluate callbacks)
      },
    },
    rules: {
      // THE rule. An identifier that is not declared anywhere in scope.
      'no-undef': 'error',
      // Using a `const`/`let` before its declaration line — the temporal dead zone. This is
      // what the logfile.js <-> browser.js import cycle produced: "Cannot access 'APP_DIR'
      // before initialization", thrown at import time, which would have taken the worker down
      // before it could write a single log line.
      'no-use-before-define': ['error', { functions: false, classes: false, variables: true }],
      // A promise rejection with no handler kills the process. The worker is long-running; a
      // single unhandled rejection ends a 90-minute block.
      'no-async-promise-executor': 'error',
      // `catch {}` on purpose is everywhere in this codebase and is usually right — a logging
      // failure must not break a run. But an EMPTY block elsewhere is nearly always a mistake,
      // so allow it only in catch.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Two functions or object keys with the same name: the second silently wins, and the
      // first — usually the one that was working — vanishes.
      'no-dupe-keys': 'error',
      'no-func-assign': 'error',
      'no-unreachable': 'error',
      // An unused variable is often half of an edit that was never finished.
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
