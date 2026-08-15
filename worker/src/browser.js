// Persistent, human-looking browser + the pause/heartbeat poller for the dashboard.
import { chromium, firefox } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logEvent } from './logfile.js';
import { fault } from './fault.js';

// When packaged as a single .exe (pkg), the code lives in a virtual snapshot — the profile
// and config must live next to the actual executable. In dev (run from the worker folder
// via npm start), the current working directory is the worker folder. Avoids import.meta so
// the same code works both unbundled (ESM) and bundled (CJS in the packaged app).
export const APP_DIR = process.pkg ? path.dirname(process.execPath) : process.cwd();

/**
 * Launch the automation browser.
 *
 * Preference order:
 *  1. the bundled Camoufox (downloaded on first use) — no dependency on what's installed, and
 *     hardened against the fingerprinting job boards actually check;
 *  2. the user's Chrome / Edge, so an existing setup keeps working if the download fails.
 *
 * `headless` runs it with no window at all: once a portal is signed in, runs happen silently
 * in the background and the terminal log is the only surface. The first run stays visible so
 * the sign-in can actually be done.
 */
/**
 * How many times LinkedIn's anti-bot has fired this process. Read by the adapters so an
 * unreadable page can be reported as what it is — a block — rather than as "no results".
 */
let botChallenges = 0;
export function botChallengeCount() { return botChallenges; }

/**
 * Close the automation browser and make sure its PROCESS is actually gone.
 *
 * `ctx.close()` closes the Playwright context. With the bundled Camoufox it does not reliably
 * end the underlying process, and every recovery path added between v133 and v150 — the idle
 * relaunch, the dead-browser retry, Connect reopening a window — called `ctx.close()` and
 * moved straight on.
 *
 * So each "relaunch" left the old process alive still holding an exclusive lock on
 * .profile-ff. The new instance could not take the lock, both died, the next recovery left
 * another orphan, and the run spiralled: FIFTEEN Camoufox processes and 4.1 GB of RAM on the
 * owner's machine, every search returning zero because the browser was dead rather than
 * because the portal withheld anything. The recovery machinery caused the failure it was
 * recovering from, and it looked exactly like being blocked — which is what I diagnosed, twice,
 * wrongly.
 *
 * Camoufox is bundled by JobPilot and nothing else on the machine runs it, so any surviving
 * camoufox process after a close is ours and is an orphan. Killing it is safe and is the only
 * thing that reliably frees the profile.
 */
/** Which browser processes each context owns, so closing one cannot kill another's. */
const OWNED_PIDS = new WeakMap();

export async function closeBrowser(ctx, { log = () => {} } = {}) {
  const mine = OWNED_PIDS.get(ctx) || null;
  try { await ctx?.close(); } catch { /* already gone */ }
  // Give the process a moment to exit cleanly before forcing it — a clean exit flushes
  // cookies.sqlite, and killing too eagerly is how a fresh sign-in gets lost.
  await sleep(1500);
  // KILL ONLY WHAT WE LAUNCHED.
  //
  // This used to call killStrayBrowsers, which runs `taskkill /F /IM camoufox.exe /T` and takes
  // out every Camoufox on the machine. Three worker processes started on 2026-08-14 (06:30,
  // 12:46, 12:47) — with two alive at once, one worker closing its browser kills the other's
  // mid-run, and the victim sees exactly what has been reported all along: a browser that died
  // for no local reason. Image-name killing is right at STARTUP, where clearing orphans is the
  // whole point, and wrong everywhere else.
  if (mine && mine.length) {
    await killPids(mine);
    logEvent('lifecycle', { event: 'closed own browser', pids: mine });
  } else {
    // No recorded pids (an older context, or the snapshot failed) — fall back to the blunt
    // instrument rather than leaking a process, and say that is what happened.
    logEvent('lifecycle', { event: 'closing browser without pid record — using image-name kill' });
    await killStrayBrowsers({ log });
  }
  OWNED_PIDS.delete(ctx);
}

/** Camoufox pids currently running, so a launch can work out which ones it created. */
async function browserPids() {
  const { execFile } = await import('node:child_process');
  const run = (cmd, args) => new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 10000 }, (err, stdout) => resolve(String(stdout || '')));
    } catch { resolve(''); }
  });
  const out = process.platform === 'win32'
    ? await run('tasklist', ['/FI', 'IMAGENAME eq camoufox.exe', '/NH', '/FO', 'CSV'])
    : await run('pgrep', ['-f', 'camoufox']);
  const pids = process.platform === 'win32'
    ? [...out.matchAll(/"camoufox\.exe","(\d+)"/gi)].map((m) => Number(m[1]))
    : out.split('\n').map((n) => Number(n.trim())).filter(Boolean);
  return pids.filter((n) => Number.isFinite(n) && n > 0);
}

async function killPids(pids) {
  const { execFile } = await import('node:child_process');
  const run = (cmd, args) => new Promise((resolve) => {
    try { execFile(cmd, args, { timeout: 10000 }, () => resolve()); } catch { resolve(); }
  });
  for (const pid of pids) {
    if (process.platform === 'win32') await run('taskkill', ['/F', '/T', '/PID', String(pid)]);
    else { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
}


/**
 * Kill any Camoufox still running. Called on close and again at startup.
 *
 * Startup matters as much as close: an orphan left by a previous session (or a crash) holds the
 * profile lock before the new worker even launches, so the very first browser of the run is
 * already doomed. Clearing them first is what makes a restart actually fix things.
 */
export async function killStrayBrowsers({ log = () => {} } = {}) {
  try {
    const { execFile } = await import('node:child_process');
    const run = (cmd, args) => new Promise((resolve) => {
      try { execFile(cmd, args, { timeout: 10000 }, () => resolve()); } catch { resolve(); }
    });
    if (process.platform === 'win32') {
      await run('taskkill', ['/F', '/IM', 'camoufox.exe', '/T']);
    } else {
      await run('pkill', ['-f', 'camoufox']);
    }
    logEvent('lifecycle', { event: 'killed stray browser processes', platform: process.platform });
    log('     (cleared any leftover automation browser processes)');
  } catch (e) {
    logEvent('lifecycle', { event: 'stray-kill failed', error: String(e && e.message).slice(0, 160) });
  }
}

/**
 * Total resident memory of every automation browser process, in MB.
 *
 * Measured on this machine, and the numbers are why this function exists:
 *
 *   baseline (browser + 1 page)  ..............   491 MB across  7 processes
 *   per abandoned application window  .........   204 MB and 1.3 processes
 *   24 abandoned windows (one real run)  ......  ~4.9 GB on top of the baseline
 *   free RAM available  .......................  ~5 GB
 *
 * So a run reaches the end of the machine's memory at about 25 leaked windows — which is
 * roughly 50 minutes of work at two minutes a job, and squarely inside the 20-to-60-minute
 * window in which the browser has been dying. Idleness was ruled out separately: two Camoufox
 * instances left alone for 14 minutes, one pinged and one untouched, both survived.
 *
 * Closing the windows is not enough on its own. After closing all twelve, memory settled at
 * 2257 MB against a 491 MB baseline — 1.7 GB never came back. Firefox does not return it, so
 * the browser has to be recycled as well as tidied.
 */
export async function browserMemoryMB(ctx) {
  if (process.platform !== 'win32') return 0;   // only Windows is measured here
  const { execFile } = await import('node:child_process');
  const run = (cmd, args) => new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 8000 }, (err, stdout) => resolve(String(stdout || '')));
    } catch { resolve(''); }
  });
  const out = await run('tasklist', ['/FI', 'IMAGENAME eq camoufox.exe', '/NH', '/FO', 'CSV']);
  // Pid AND memory from the same row, so the two can be matched up.
  const rows = [...out.matchAll(/"camoufox\.exe","(\d+)"[^\r\n]*?"([\d,]+) K"/g)]
    .map((m) => ({ pid: Number(m[1]), kb: Number(m[2].replace(/,/g, '')) }));

  // ONLY THE BROWSER WE OWN.
  //
  // Summing every camoufox on the machine was wrong in both directions. In the test suite it
  // counted other tests' browsers and tripped the recycle in the middle of unrelated cases —
  // 22 failures, all of them this. In production it would do the same for a second worker, or
  // for the browser the desktop app opened for a sign-in: we would restart OUR browser because
  // somebody else's was large, over and over, and free nothing each time.
  //
  // The owned pids are recorded at launch. Without them (an older context, or the snapshot
  // failed) the honest answer is 0 — "unmeasurable" — rather than a machine-wide number that
  // would recycle for the wrong reason. `recycleIfBloated` treats 0 as "do not act".
  const mine = ctx ? OWNED_PIDS.get(ctx) : null;
  const counted = mine && mine.length ? rows.filter((r) => mine.includes(r.pid)) : [];
  if (!counted.length) return 0;
  return Math.round(counted.reduce((s, r) => s + r.kb, 0) / 1024);
}

/**
 * When to recycle. TWO conditions, because one number cannot describe both failures.
 *
 * `BROWSER_MEMORY_LIMIT_MB` catches the browser growing: 2500 MB is five times the idle
 * baseline of 491 MB, and about twelve leaked windows at the measured 204 MB apiece.
 *
 * `FREE_MEMORY_FLOOR_MB` catches the MACHINE running out, which the first number cannot see.
 * 2500 was chosen against ~5 GB free; a later reading on the same machine showed 3.7 GB, and
 * whatever else is open moves that number all day. What actually matters is not how big the
 * browser is, it is whether there is still room to START THE REPLACEMENT — and a launch needs
 * roughly the 491 MB baseline. Below 1200 MB free, a relaunch is not reliable: Camoufox failed
 * to start in this project's own test suite while 2.17 GB of browsers were resident, with
 * "RenderCompositorSWGL failed mapping default framebuffer" and "gBrowser never populated".
 * That is the same failure seen at 03:58 on 2026-08-15, and it is what recycling too late
 * looks like: no memory left to recover with.
 */
export const BROWSER_MEMORY_LIMIT_MB = 2500;
export const FREE_MEMORY_FLOOR_MB = 1200;

/**
 * Free physical memory, MB. `os.freemem()` rather than shelling out — it is instant, and this
 * is checked between every job.
 */
export function freeMemoryMB() {
  return Math.round(os.freemem() / (1024 * 1024));
}

/** The signal a block raises to ask for a fresh browser. Recognised by index.js. */
export const RECYCLE_SIGNAL = 'jobpilot: recycle the browser (memory)';

export async function launchBrowser({ headless = false, log = console.log } = {}) {
  const userDataDir = path.join(APP_DIR, '.profile'); // persisted logins live here
  fs.mkdirSync(userDataDir, { recursive: true });

  // Firefox profiles are not Chromium profiles — keep them apart so neither corrupts the other.
  const ffDir = path.join(APP_DIR, '.profile-ff');
  const { ensureBrowser } = await import('./browser-setup.js');
  const exe = await ensureBrowser(log).catch(() => null);
  if (exe) {
    // TRY CAMOUFOX SEVERAL TIMES BEFORE GIVING UP ON IT.
    //
    // One failed attempt used to fall straight through to Chrome — and Chrome uses a DIFFERENT
    // PROFILE DIRECTORY, so every saved sign-in silently disappears. The run of 2026-08-15
    // shows the whole chain in five lines: strays killed at 03:58:05, Camoufox refused to start
    // at 03:58:10 with "Target page, context or browser has been closed", Chrome took over on
    // .profile, found no session, declared the portals signed out and opened a login window.
    // The credentials were saved the entire time — in .profile-ff, the profile the run had just
    // walked away from. That is why it "keeps opening browsers and never signs in".
    //
    // The failure is a profile lock, not a broken browser: Firefox does not release the lock on
    // .profile-ff the instant the previous process is killed, and the first launch lands inside
    // that window. Waiting and retrying costs a few seconds; falling back costs the session.
    for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      fs.mkdirSync(ffDir, { recursive: true });
      const before = await browserPids().catch(() => []);
      const ctx = await firefox.launchPersistentContext(ffDir, {
        executablePath: exe,
        headless,
        viewport: null,
        // Inherit the machine's real locale/timezone — pinning them is itself a signal.
      });
      log(headless
        ? '  Automation browser running in the background (no window).'
        : '  Automation browser open.');
      log(`     [profile] Camoufox — ${ffDir}`);
      // Diff the process list either side of the launch: whatever is new belongs to us. The
      // parent Camoufox spawns children, so /T on each pid takes the tree with it.
      const after = await browserPids().catch(() => []);
      const ours = after.filter((p) => !before.includes(p));
      if (ours.length) OWNED_PIDS.set(ctx, ours);
      logEvent('lifecycle', { event: 'browser launched', pids: ours, headless });
      const hardened = await harden(ctx);
      startHeartbeat(ctx, hardened);
      return { ctx, page: hardened };
    } catch (e) {
      // SIX attempts, and NEVER a fallback. See below for why the fallback is gone entirely.
      if (attempt < 6) {
        // Almost always the profile lock from the process we just killed. Before waiting, make
        // sure nothing is still holding it — a survivor of the taskkill is the usual reason a
        // retry fails as often as the first attempt did.
        const survivors = await browserPids().catch(() => []);
        if (survivors.length) {
          logEvent('lifecycle', { event: 'killing lock holders before retry', pids: survivors });
          await killPids(survivors);
        }
        log(`  · automation browser busy (attempt ${attempt} of 6) — waiting for the profile `
          + 'to be released…');
        logEvent('lifecycle', { event: 'camoufox launch retry', attempt,
          survivors: survivors.length, error: String(e && e.message).slice(0, 160) });
        await sleep(attempt * 2000);
        continue;
      }
      // Falling back to Chrome switches PROFILE DIRECTORY as well as browser: Camoufox keeps
      // its session in .profile-ff, Chrome in .profile. A sign-in done in one is invisible to
      // the other, so a run that launches Camoufox after you signed in through the Chrome
      // fallback reports "not signed in" against a session that genuinely exists — it is just
      // in the other folder. Say so loudly; a silent fallback makes that indistinguishable
      // from a login that was never saved.
      // NO FALLBACK TO CHROME WHEN CAMOUFOX EXISTS. This is the important line in the file.
      //
      // Chrome uses .profile; Camoufox uses .profile-ff. They are different browsers with
      // incompatible profile formats, so switching does not "degrade gracefully" — it throws
      // away every saved sign-in and makes the app announce that you are logged out of accounts
      // you are logged into. That is not a fallback, it is a different product with none of
      // your data, and it silently changed the browser fingerprint the job boards check as well.
      //
      // Chrome remains the bootstrap for one case only, handled above: Camoufox could not be
      // DOWNLOADED at all (first run, no network). If the binary exists and will not start,
      // that is a local, fixable condition — a lock, a half-written profile — and the honest
      // response is to say so and stop, not to quietly become a different browser.
      log(`
  ✋ The automation browser would not start after 6 attempts.`);
      log(`     Last error: ${String(e.message).slice(0, 140)}`);
      log('     Your sign-ins are safe — they live in the browser profile, not in the app.');
      log('     Quit JobPilot from the tray and open it again. If it persists, delete');
      log(`     ${ffDir} and sign in once more.`);
      logEvent('lifecycle', { event: 'camoufox launch failed — refusing to switch profiles',
        attempts: 6, ffDir, error: String(e && e.message).slice(0, 200) });
      fault('BROWSER_WILL_NOT_START', { ffDir, error: String(e && e.message).slice(0, 200) });
      throw new Error(`the automation browser would not start: ${String(e.message).slice(0, 120)}`);
    }
    }
  }
  // Only reached when Camoufox could not be obtained at all — the genuine bootstrap case.
  log('\n  ⓘ The bundled automation browser is not available, so Chrome is being used instead.');
  log('     Chrome keeps its sign-ins in a SEPARATE profile, so you will be asked to sign in');
  log('     once here. This is the first-run path; it should not happen twice.');
  logEvent('lifecycle', { event: 'chrome bootstrap — camoufox unavailable' });
  const opts = {
    headless,
    // A real window, not a scripted 1280x800 box — a fixed odd viewport is itself a signal.
    viewport: null,
    // Playwright disables the Chrome sandbox by default, which makes Chrome show the yellow
    // "unsupported command-line flag: --no-sandbox" banner. That banner is a loud automation
    // tell that bot-detection (Indeed/Cloudflare) reads — keep the sandbox ON.
    chromiumSandbox: true,
    // Drops the "Chrome is being controlled by automated test software" infobar.
    ignoreDefaultArgs: ['--enable-automation'],
    // Locale/timezone deliberately NOT set: inheriting the real machine's values is more
    // authentic than pinning them.
    // NOTE: '--disable-blink-features=AutomationControlled' is deliberately NOT passed.
    // Current Chrome treats it as unsupported and prints the yellow "You are using an
    // unsupported command-line flag" banner — the very automation tell it was meant to hide.
    // navigator.webdriver is patched in harden() instead, which leaves no banner.
    args: ['--start-maximized'],
  };
  try {
    const ctx = await chromium.launchPersistentContext(userDataDir, { ...opts, channel: 'chrome' });
    log(`     [profile] Chrome — ${userDataDir}`);
    const hardened = await harden(ctx);
    startHeartbeat(ctx, hardened);
    return { ctx, page: hardened };
  } catch (e) {
    try {
      const ctx = await chromium.launchPersistentContext(userDataDir, { ...opts, channel: 'msedge' });
      const hardened = await harden(ctx);
      startHeartbeat(ctx, hardened);
      return { ctx, page: hardened };
    } catch {
      console.error('\n  Could not find Google Chrome (or Microsoft Edge) on this computer.');
      console.error('  Install Chrome from https://www.google.com/chrome and run JobPilot Desktop again.\n');
      throw e;
    }
  }
}

/**
 * Belt-and-braces fingerprint cleanup applied to every page (including ones the apply flows
 * open later) — patches the few properties automation still leaks, on top of whatever
 * hardening the browser itself provides.
 */
/**
 * The browser's OWN account of its death, recorded the instant it happens.
 *
 * Until now a dead browser was DISCOVERED, not observed: the next navigation threw "Target page,
 * context or browser has been closed" and the run inferred it, sometimes minutes later. On
 * 2026-08-14 the last page activity was at 14:28:10 and the death surfaced at 14:34:47 — a
 * 6.6-minute hole in which the only honest statement was "it died at some point in here". No
 * uptime, no last-known-good moment, nothing to correlate against.
 *
 * Two jobs, both cheap:
 *   · listen for the context's own `close` and each page's `crash`, so the moment is recorded
 *     by the browser rather than deduced from a later failure
 *   · touch the page every 30s so a death during a long idle surfaces then, not at the next
 *     search — the run rests for minutes at a time (Indeed's throttle backoff is 1+2+3), and
 *     those rests are exactly when it has been dying
 *
 * The heartbeat is deliberately tolerant: `evaluate` legitimately throws while a navigation is
 * in flight, so it takes three consecutive failures to call it a death. One strict check here
 * would manufacture the outage it is meant to observe — which this project has already done
 * once, with the recovery machinery that orphaned browsers.
 */
function startHeartbeat(ctx, page) {
  const bornAt = Date.now();
  let lastOk = Date.now();
  let misses = 0;
  let reported = false;

  const report = (how, extra = {}) => {
    if (reported) return;
    reported = true;
    logEvent('lifecycle', {
      event: 'browser died',
      how,
      uptimeMs: Date.now() - bornAt,
      // How long it had been since the browser last answered. A large value means it died
      // during an idle rest; a small one means it died under load. Those are different bugs.
      quietForMs: Date.now() - lastOk,
      ...extra,
    });
  };

  try {
    ctx.on('close', () => report('context closed'));
    ctx.on('page', (p) => {
      try { p.on('crash', () => report('page crashed', { url: p.url() })); } catch { /* ignore */ }
    });
    page.on('crash', () => report('page crashed', { url: page.url() }));
  } catch { /* a listener that throws must never break the launch */ }

  const timer = setInterval(async () => {
    if (reported) return;
    try {
      await page.evaluate(() => 1);
      lastOk = Date.now();
      misses = 0;
    } catch (e) {
      misses++;
      if (misses >= 3) report('heartbeat stopped', { error: String(e && e.message).slice(0, 160) });
    }
  }, 30_000);
  // Never hold the process open on this alone.
  if (timer.unref) timer.unref();
  try { ctx.on('close', () => clearInterval(timer)); } catch { /* ignore */ }
  return timer;
}

async function harden(ctx) {
  // Record what the browser actually did. Which URL a job page really landed on — a redirect to
  // an authwall, a 999 rate-limit, a challenge — was never written down anywhere, so "the job
  // page did not render" has been an unexplained symptom for days. Attached at the CONTEXT so
  // pages opened later by the apply flows are covered too, and every handler is defensive: a
  // logging listener that throws would break navigation itself.
  const watch = (p) => {
    try {
      p.on('framenavigated', (f) => {
        try { if (f === p.mainFrame()) logEvent('nav', { url: f.url() }); } catch { /* ignore */ }
      });
      p.on('response', (r) => {
        try {
          // LinkedIn's bot detection, caught at the only place it is visible.
          //
          // PerimeterX / HUMAN Security is loaded as li.protechts.net with app_id=PX… and a
          // `uc=scraping` parameter — LinkedIn labelling the session, in as many words. It
          // arrives with a reCAPTCHA Enterprise frame, and once it escalates the job-cards API
          // starts returning 503, results come back empty and the session stops being honoured.
          //
          // Nothing surfaced this. The run read the empty results as "no jobs", printed
          // "0 Easy-Apply jobs" seventy times, announced "every search was exhausted" and
          // finished — while the real answer was sitting in the network traffic all along.
          const u = r.url();
          if (/protechts\.net|perimeterx|px-cdn|recaptcha\/enterprise/i.test(u)) {
            botChallenges++;
            if (botChallenges === 1) logEvent('bot-detection', { first: u.slice(0, 300) });
          }
        } catch { /* ignore */ }
        try {
          // Only the document itself and anything that failed — logging every image would bury
          // the signal and the file would be gigabytes.
          const st = r.status();
          if (st >= 400 || r.request().resourceType() === 'document') {
            logEvent('net', { status: st, type: r.request().resourceType(), url: r.url().slice(0, 300) });
          }
        } catch { /* ignore */ }
      });
      p.on('pageerror', (e) => logEvent('pageerror', String(e && e.message).slice(0, 300)));
      p.on('crash', () => logEvent('pageerror', 'the page crashed'));
    } catch { /* ignore */ }
  };
  ctx.on('page', watch);
  ctx.pages().forEach(watch);

  await ctx.addInitScript(() => {
    // CDP sets this to true; real browsing has it undefined.
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Automation contexts sometimes report zero plugins / empty languages.
    if (!navigator.plugins || navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    }
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    }
  }).catch(() => { /* older Playwright — flags alone still help */ });
  return ctx.pages()[0] || (await ctx.newPage());
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Human-ish jitter so actions never fire at a robotic fixed cadence. */
export function humanDelay(min = 700, max = 1800) {
  // The adapter test harness sets JOBPILOT_TEST_NO_PACING so a suite that drives dozens of
  // pages finishes in two minutes rather than twenty. Read at CALL time, not at import time:
  // ES module imports are hoisted, so a harness that sets the variable in its own module body
  // would lose the race against this module being evaluated. Nothing in the app ever sets it —
  // the jitter is a large part of what keeps a run from reading as a script.
  if (process.env.JOBPILOT_TEST_NO_PACING === '1') return sleep(0);
  return sleep(min + Math.floor(Math.random() * (max - min)));
}

/**
 * Poll the backend so the main loop halts promptly when the owner hits Pause, and so the
 * dashboard keeps seeing the worker's heartbeat. Replaces the old 1-JPEG/sec "Watch Live"
 * streamer — that uploaded a screenshot every second, which burned the VM's free egress
 * budget for a feature nobody used. Returns a stop().
 */
export function startPausePoller(api, state, reportSessions) {
  let stopped = false;
  let missedRun = 0;   // consecutive polls where our run was not the active one
  let lastReply = '';  // the raw /next body that triggered it — see below
  let ticks = 0;
  const tick = async () => {
    while (!stopped) {
      // Refresh the portal cards DURING a run, not only between blocks.
      //
      // Session status was reported from the main loop only, which a running block owns for up
      // to 90 minutes. So signing in mid-run left the Connections card — and the banner on the
      // portal page — insisting "LinkedIn is not connected" while the terminal was happily
      // applying to jobs. The dashboard was describing a state that had already been fixed, and
      // the only cure was waiting out the whole block. Every 20th tick is once a minute.
      //
      // INSIDE the try, and this matters more than it looks. This loop is the worker's
      // heartbeat: /next below is what tells the backend the desktop app is alive. If anything
      // here throws, the while loop exits, the heartbeat stops, and ten minutes later the
      // stale-run reaper ends a perfectly healthy run with "the desktop app stopped while it
      // was running" — the exact message the dashboard has been showing. A cosmetic card
      // refresh must never be able to kill the heartbeat.
      try {
        if (reportSessions && ticks++ % 20 === 0) await reportSessions().catch(() => {});
        // /next heartbeats the worker (dashboard "desktop ready") and reports the pause flag.
        // It's a GET that only promotes queued→running, so polling it mid-run is a no-op.
        const r = await api.next();
        state.paused = !!(r && r.paused);
        // STOP detection. Clicking Stop marks the run finished, so /next stops returning it.
        // The block loop only re-checks /next between blocks, so without this a Stop wouldn't
        // take effect until the whole current block (all those searches) finished — which read
        // as "it doesn't stop until I disconnect". If the run we're mid-way through has vanished
        // from /next (idle, or a different run), abort it now.
        if (state.runId && !state.paused) {
          const activeId = r && r.runId ? String(r.runId) : null;
          if (activeId !== String(state.runId)) {
            // TWO consecutive observations, not one. A single divergence happens whenever the
            // backend blips — and this flag silently breaks every loop in the running block, so
            // acting on one reading turned a two-second hiccup into a dead hour that printed
            // nothing at all. Say it out loud too: this was invisible before.
            missedRun++;
            // Keep the raw reply. "The server reports nothing running" has now been blamed on
            // the reaper, on backend deploys and on a heartbeat window, and the run records
            // afterwards said `done`, not `failed` — which fits none of those. Guessing from
            // the outside has cost days, so record exactly what /next returned at the moment
            // the decision was made.
            lastReply = JSON.stringify(r || null).slice(0, 200);
            if (missedRun === 2) {
              // Say it ONCE, and say enough to diagnose it. This printed on every subsequent
              // tick, three times in one run, while explaining nothing about the cause — and
              // "it was stopped or ended" covers a Stop click, a finished run, a backend
              // redeploy that dropped the run, and a rotation starting a different portal.
              // Those need different fixes, so name which one it was.
              console.log(`\n  ■ Run ${state.runId} is no longer the active run on the server`
                + ` — ${activeId ? `the server is now running ${activeId}` : 'the server reports nothing running'}.`);
              // The raw reply, because every theory so far has been wrong. This has been blamed
              // on the reaper, on backend deploys and on a 30-second heartbeat window — and the
              // run records afterwards read `done` with "Block complete", which fits none of
              // them. One line here ends the guessing.
              console.log(`     [diag] /next replied: ${lastReply}`);
              console.log('     Finishing this block.');
              state.stopped = true;
            }
          } else {
            missedRun = 0;
          }
        }
      } catch (_) { /* transient network — try again next tick */ }
      await sleep(3000);
    }
  };
  tick();
  return () => { stopped = true; };
}
