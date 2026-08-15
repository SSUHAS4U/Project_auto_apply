// Indeed adapter. Drives Indeed's native "Apply now" (Indeed Apply / smartapply) on the
// owner's logged-in session — the multi-step apply flow, answering screening questions
// from the profile/AI. Jobs that redirect to an employer site ("Apply on company site")
// are skipped. Indeed is aggressive about bot detection, so this is deliberately slow and
// conservative; if a captcha/checkpoint appears it stops and flags "needs attention".
import fs from 'node:fs';
import { fault } from '../fault.js';
import { logEvent } from '../logfile.js';
import path from 'node:path';
import { humanDelay, sleep, APP_DIR, browserMemoryMB, BROWSER_MEMORY_LIMIT_MB, FREE_MEMORY_FLOOR_MB,
  freeMemoryMB, RECYCLE_SIGNAL } from '../browser.js';
import { logJobHeader, logSkipped, logResult, beginJob, setLedger } from '../log.js';
import { newLedger, seal } from '../ledger.js';
import { fillForm, fillChoices, fillDropdowns, observeResume } from '../fill.js';
import { shouldApply } from '../gate.js';

// Indeed throttles job pages under sustained access. Rest up to 3 times (1m + 2m + 3m)
// before treating the wall as real — see the blocked-jobs path for why quitting was wrong.
const MAX_BACKOFFS = 3;

// Seniority filter only. The compatibility decision lives in `gate.js → shouldApply`, shared
// with LinkedIn, so the two portals cannot disagree about what is worth applying to.
const SENIOR_RE = /\b(senior|sr\.?|lead|principal|staff|architect|manager|director|head\s+of|vp|vice\s*president)\b/i;

// Indeed is COUNTRY-SPECIFIC: www.indeed.com is the US site and returns nothing for an Indian
// city — which is exactly why every search came back "0 results". Indian jobs live on
// in.indeed.com. Pick the domain from the search location / the profile's country.
const COUNTRY_HOSTS = [
  [/\b(india|bengaluru|bangalore|hyderabad|chennai|mumbai|pune|delhi|noida|gurugram|gurgaon|kolkata|ahmedabad|kochi|coimbatore|vijayawada|visakhapatnam|indore|jaipur|chandigarh)\b/i, 'in.indeed.com'],
  [/\b(united kingdom|uk|london|manchester)\b/i, 'uk.indeed.com'],
  [/\b(canada|toronto|vancouver)\b/i, 'ca.indeed.com'],
  [/\b(australia|sydney|melbourne)\b/i, 'au.indeed.com'],
  [/\b(singapore)\b/i, 'sg.indeed.com'],
  [/\b(germany|berlin|munich)\b/i, 'de.indeed.com'],
];
function hostFor(location, profile) {
  const hay = `${location || ''} ${profile?.location || ''} ${profile?.country || ''}`;
  for (const [re, host] of COUNTRY_HOSTS) if (re.test(hay)) return host;
  return 'www.indeed.com';
}

// Indeed pages at ~15 results. Reading only page 1 is why every search reported "16 result(s)"
// and why the same handful of postings came back for every city — there was never a second page
// to find anything new on. `start` is Indeed's offset parameter (0, 10, 20 …).

function searchUrl(keyword, location, profile, start = 0, maxAgeDays = 0) {
  const p = new URLSearchParams({ q: keyword, sort: 'date' });
  if (location && location.toLowerCase() !== 'remote') p.set('l', location);
  else p.set('l', 'Remote');
  if (start > 0) p.set('start', String(start));
  // `fromage` = max posting age in days, and Indeed accepts ONLY the values its own filter
  // offers: 1, 3, 7, 14. Anything else is rejected as a malformed request and served a
  // Cloudflare challenge instead of results. We were sending the setting straight through, so
  // the default of 30 produced:
  //     GET /jobs?...&fromage=30  ->  HTTP 403  "Just a moment... Additional Verification"
  // on EVERY search. Verified against live in.indeed.com: 1/3/7/14 all return 200 with cards,
  // 30 returns 403. So the "captcha" Indeed appeared to be showing was one we asked for.
  // Round down to the nearest value Indeed will accept; below 1 day, drop the filter entirely.
  if (maxAgeDays > 0) {
    const allowed = [14, 7, 3, 1].find((d) => d <= maxAgeDays);
    if (allowed) p.set('fromage', String(allowed));
  }
  return `https://${hostFor(location, profile)}/jobs?${p.toString()}`;
}

/** The results-page URL with a job opened in the right-hand pane. See the call site for why. */
function jobPaneUrl(keyword, location, profile, jk, maxAgeDays = 0) {
  const base = searchUrl(keyword, location, profile, 0, maxAgeDays);
  return `${base}&vjk=${encodeURIComponent(jk)}`;
}

async function collectJobKeys(page) {
  // Indeed renames these constantly; cast wide and also mine any /viewjob?jk= or /rc/clk?jk=
  // link on the page so a class rename can't zero out the whole search.
  const keys = await page.$$eval(
    '[data-jk], a[href*="jk="], a[href*="/viewjob"], .job_seen_beacon, [data-testid="slider_item"]',
    (nodes) => nodes.flatMap((n) => {
      const out = [];
      const dj = n.getAttribute && n.getAttribute('data-jk');
      if (dj) out.push(dj);
      const href = (n.getAttribute && n.getAttribute('href')) || '';
      const m = href.match(/[?&]jk=([0-9a-zA-Z]+)/);
      if (m) out.push(m[1]);
      const inner = n.querySelector && n.querySelector('[data-jk], a[href*="jk="]');
      if (inner) {
        const idj = inner.getAttribute('data-jk');
        if (idj) out.push(idj);
        const im = (inner.getAttribute('href') || '').match(/[?&]jk=([0-9a-zA-Z]+)/);
        if (im) out.push(im[1]);
      }
      return out;
    }).filter(Boolean),
  ).catch(() => []);
  return [...new Set(keys)];
}

/** When a search yields nothing, print what the page actually is — no more silent zeros. */
async function describeSearch(page) {
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title.slice(0, 90),
    cards: document.querySelectorAll('[data-jk], .job_seen_beacon').length,
    bodyStart: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 220),
  })).catch(() => null);
  if (!info) { console.log('     [diag] could not read the page'); return; }
  console.log(`     [diag] landed on: ${info.url}`);
  console.log(`     [diag] title: ${info.title}`);
  console.log(`     [diag] job cards in DOM: ${info.cards}`);
  console.log(`     [diag] page text: ${info.bodyStart}`);
}

async function readPosting(page) {
  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => '');
  return {
    // h2, not h1 — and NOT a bare `h1`, which on the results page is "Backend Developer jobs
    // in Bengaluru, Karnataka" (the SERP heading) rather than the posting. Verified live: the
    // pane title lives in h2.jobsearch-JobInfoHeader-title and always carries a " - job post"
    // suffix, which would otherwise reach the fit gate and the dashboard as part of the role.
    title: (await text('h2.jobsearch-JobInfoHeader-title, [data-testid="jobsearch-JobInfoHeader-title"], '
      + '.jobsearch-JobInfoHeader-title, h1.jobsearch-JobInfoHeader-title'))
      .replace(/\s*-\s*job post\s*$/i, '').trim(),
    company: await text('[data-testid="inlineHeader-companyName"], .jobsearch-CompanyInfoContainer a'),
    location: await text('[data-testid="inlineHeader-companyLocation"], [data-testid="job-location"]'),
    description: await text('#jobDescriptionText, .jobsearch-JobComponent-description'),
    salary: (await text('#salaryInfoAndJobType [data-testid="attribute_snippet_testid"], #salaryInfoAndJobType .attribute_snippet, .jobsearch-JobMetadataHeader-item'))
      .replace(/\s+/g, ' ').slice(0, 90),
  };
}

// Phrases that only appear on an actual challenge page, matched against VISIBLE text.
const CHALLENGE_RE = /verify (?:you are|that you are|you're) (?:a )?human|are you a human|unusual traffic|security check|additional verification|checking your (?:browser|connection)|press and hold|solve the (?:captcha|puzzle)|enable javascript and cookies/i;

/**
 * What is on screen: 'ok' | 'blocked' | 'unreadable'.
 *
 * Three states, not two, because the three have different fixes and this function has now
 * twice manufactured an outage by collapsing them:
 *
 *  1. It matched "captcha" anywhere in the raw HTML. Cloudflare injects a telemetry config
 *     containing `"captcha":{…}` into every page it fronts, so every healthy page read as a
 *     wall and the block died in silence.
 *  2. It then matched `iframe[src*="recaptcha"]`. Indeed runs reCAPTCHA v3 site-wide — a 0x0
 *     invisible iframe on ORDINARY pages — so healthy pages read as walls again.
 *  3. And when `evaluate` threw, it returned "not blocked". A challenge page reloads itself,
 *     destroying the execution context, so the throw WAS the signal; calling it healthy turned
 *     a wedged session into seventy consecutive "0 result(s)" lines.
 *
 * So: visible text only (scripts cannot vote), a challenge widget only if actually rendered,
 * job results always win, and an unreadable page says so instead of guessing.
 */
async function pageState(page) {
  const sig = await page.evaluate(() => {
    // A challenge widget only counts if it is actually PUT IN FRONT OF YOU. reCAPTCHA v3 is
    // invisible by design: it embeds an iframe whose src contains "recaptcha" on ordinary
    // pages to score traffic silently, and Indeed runs it site-wide. Matching the selector
    // alone therefore reported every healthy search page as a captcha wall — the second time
    // this detector has manufactured its own outage. Require a real, rendered box.
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 120 && r.height >= 120 && getComputedStyle(el).visibility !== 'hidden';
    };
    const widget = [...document.querySelectorAll(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[title*="captcha" i],'
      + ' iframe[title*="challenge" i], #challenge-form, #challenge-running, .g-recaptcha,'
      + ' .h-captcha, [data-testid="captcha"], form[action*="challenge"]')].some(visible);
    return {
      title: (document.title || '').toLowerCase(),
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').toLowerCase().slice(0, 4000),
      widget,
      // Corroboration. A page that is serving job results is not a wall, whatever else it
      // happens to contain — and this is the one signal that cannot be faked by a stray script.
      hasResults: document.querySelectorAll('[data-jk], .job_seen_beacon, a[href*="/viewjob"]').length > 0,
    };
  }).catch(() => null);
  // "Could not read it" is NOT "it looked fine". A challenge page reloads itself, which
  // destroys the execution context mid-evaluate, so this throws — and returning false there
  // reported the page as healthy. collectJobKeys then failed the same way and the search
  // printed "0 result(s)". A real run did that seventy times in a row, in silence, with the
  // diagnostic dump suppressed because it had already fired once. Say which it was.
  if (!sig) return 'unreadable';
  if (sig.hasResults) return 'ok';
  if (sig.widget) return 'blocked';
  if (/^(blocked|just a moment|attention required|access denied|security check)/.test(sig.title)) return 'blocked';
  return CHALLENGE_RE.test(sig.text) ? 'blocked' : 'ok';
}

/**
 * Is there a live Indeed session? The auth cookie is the source of truth.
 *
 * Indeed had no sign-in check at all: a signed-out run walked every search, found nothing
 * applyable, and finished by listing "usual causes" — offering "not signed in" as one guess
 * among three when the cookie sitting in the profile answers it outright. LinkedIn already
 * checks this; the asymmetry was the bug.
 */
async function indeedLoggedIn(page, api, state) {
  const cookies = await page.context().cookies('https://www.indeed.com').catch(() => []);
  // The auth cookie and nothing else — the same rule connections.js applies, so the run and the
  // Connections card can never disagree. A "any session-looking cookie name" fallback is what
  // made a signed-out LinkedIn read as connected (JSESSIONID matches /SID/), and Indeed hands
  // out CTK and SHOE to anonymous visitors just as freely.
  if (cookies.some((c) => c.name === 'PPID' && (c.value || '').length > 0)) return true;
  console.log('\n  ⚠ Not signed in to Indeed — the session cookie is gone.');
  console.log('     Indeed hides its own Apply button from signed-out visitors, so there is');
  console.log('     nothing to apply to. Sign in once in the window that opens; the session');
  console.log('     is remembered from then on.\n');
  await api.session('indeed', false, 'Signed out — the Indeed session cookie is gone.').catch(() => {});
  await api.event({
    runId: state.runId, portal: 'indeed', type: 'error',
    detail: 'Not signed in to Indeed. Signed-out job pages carry no Indeed Apply button, so nothing '
      + 'can be applied to. JobPilot will open a login window on the next run; sign in there once '
      + 'and the session is remembered.',
  });
  return false;
}

/**
 * Gap between one Indeed search and the next.
 *
 * A run of 72 back-to-back searches drew 277 HTTP 429s and a Cloudflare Turnstile challenge.
 * Two minutes is a rate a person plausibly produces, and over a long block it still covers most
 * of the matrix — spread out rather than burst.
 */
const INDEED_SEARCH_GAP_MS = 120_000;

export async function runIndeed(page, api, plan, state, ctx) {
  // Bail out loudly rather than walking 72 searches that cannot produce a single application.
  // Outcome buckets. Indeed returned bare `{ applied }` while LinkedIn returned the full set,
  // so logSummary printed "✅ 0 submitted ⏸ 0 need you ✋ 0 manual ⤼ 0 skipped ✗ 0 failed" over
  // a block that had just paused on 24 jobs. Nothing was miscounted — nothing was counted at
  // all, and a row of zeros reads as "the run did nothing" rather than "the run did 24 things
  // and could not finish any of them".
  const tally = { manual: 0, attention: 0, failed: 0, skipped: 0 };
  const runLedger = newLedger('indeed');
  setLedger(runLedger);
  if (!(await indeedLoggedIn(page, api, state))) return { applied: 0 };
  const profile = await api.profile().catch(() => ({}));
  // No resume fetch here on purpose: Indeed serves its own hosted resume and JobPilot
  // never uploads one, so pulling the file down would be a download nothing consumes.
  // An Indeed run lasts ~1.5h unless you stop it (floor enforced here so a stale schedule row
  // can't cut it short). Indeed has no post-scan/outreach phase — it only applies.
  // Duration comes from Automation → Schedule (Indeed minutes).
  const blockMin = Math.max(plan.blockMinutes || 120, 15);
  const deadline = Date.now() + blockMin * 60_000;
  // What's LEFT of today's Indeed quota — the backend subtracts today's applications, so a
  // shortfall carries into the next run automatically.
  const applyCap = plan.applyCap ?? 20;
  const dailyTarget = plan.dailyTarget || applyCap;
  const doneToday = plan.appliedToday || 0;
  let applied = 0;
  let blockedStreak = 0; // consecutive captcha walls — bail out instead of looping forever
  let blockedTotal = 0;  // walls hit at any point, so the summary can name the real cause
  let unreadable = 0;    // consecutive pages whose DOM could not be read at all
  let backoffs = 0;      // how many times we have rested through Indeed's throttling

  // ONE country host for the whole run — used for the searches AND the job pages. The job page
  // used to be hardcoded to www.indeed.com while the search ran on in.indeed.com, so every job
  // opened on the US site, redirected, and was silently dropped: "16 results" then nothing.
  const host = hostFor((plan.locations || [])[0], profile);
  console.log(`\n  Indeed — ${doneToday}/${dailyTarget} done today, ${applyCap} to go · ${blockMin}min block · ${host}`);
  if (applyCap === 0) { console.log("  ✓ Today's Indeed quota is already met — nothing to do."); return { applied: 0 }; }

  // Nothing to search with. Without this the loops below simply never execute and the block
  // prints its header, then its summary, with NOTHING in between — a completely silent no-op
  // that looks identical to "Indeed is broken". Say which side is empty and where to fix it.
  const kws = plan.keywords || [];
  const locs = plan.locations || [];
  if (kws.length === 0 || locs.length === 0) {
    console.log(`\n  ✋ Nothing to search: ${kws.length} search term(s), ${locs.length} location(s).`);
    console.log('     Add target roles and locations in Automation → Setup, then run again.');
    await api.event({ runId: state.runId, portal: 'indeed', type: 'error',
      detail: `Indeed had nothing to search — ${kws.length} keyword(s) and ${locs.length} location(s) in the plan. Set target roles and locations in Setup.` });
    return { applied: 0 };
  }
  console.log(`  Searching ${kws.length} term(s) × ${locs.length} location(s) = ${kws.length * locs.length} searches`);

  let totalResults = 0;
  let diagShown = false;   // dump the page diagnostics once, not on every empty search
  let blockedJobs = 0;     // consecutive job pages hidden behind a checkpoint
  const maxAgeDays = plan.maxAgeDays || 0;   // skip postings older than this
  // ONE result page per search. Pages 2 and 3 of an Indeed search are largely the same
  // postings relisted by agencies, so three pages tripled the request rate for the worst
  // results — and request rate is exactly what earned 277 429s.
  const pagesPerSearch = 1;
  void plan.pagesPerSearch;
  let sawAnyFresh = false; // did ANY search yield a job we hadn't already handled?
  let opened = 0;          // job pages actually opened — the number that was invisible before
  let externals = 0;       // jobs with no Indeed Apply button (all of them = a selector fault)
  // Indeed returns the same postings for every city (16 each time in the last run), so without
  // this the worker re-opened and re-processed the identical 16 jobs six times over.
  const doneJobs = new Set();
  // PACED AND ROTATED, the same treatment LinkedIn got — and which was never carried here.
  //
  // A run produced 277 HTTP 429s, 148 reCAPTCHA Enterprise loads and 4 Cloudflare Turnstile
  // challenges: 95 jobs paused behind a checkpoint and nothing was submitted. That is not a
  // broken adapter, it is Indeed answering 72 back-to-back searches the way any site answers
  // being hammered. LinkedIn's pacing fix cut 216 page loads to 6 and stopped its
  // `uc=scraping` flag; Indeed was left running the whole matrix flat out.
  //
  // Same shape as LinkedIn: walk keyword x location from where the last run stopped, one
  // search every two minutes, until the time budget or the apply cap ends it. The offset is
  // written after EVERY pair so a stopped or timed-out run resumes where it actually reached
  // instead of re-walking the same searches and never seeing the far end.
  const indeedPairs = [];
  for (const kw of kws) for (const loc of locs) indeedPairs.push({ keyword: kw, location: loc });
  const indeedOffsetFile = path.join(APP_DIR, '.indeed-search-offset');
  let indeedOffset = 0;
  try { indeedOffset = parseInt(fs.readFileSync(indeedOffsetFile, 'utf8'), 10) || 0; } catch { /* first run */ }
  const indeedQueue = [];
  for (let i = 0; i < indeedPairs.length; i++) {
    indeedQueue.push(indeedPairs[(indeedOffset + i) % indeedPairs.length]);
  }
  console.log(`  Starting at pair #${indeedOffset + 1} of ${indeedPairs.length}, `
    + `about one search every ${Math.round(INDEED_SEARCH_GAP_MS / 1000)}s until the budget is used.`);
  let indeedSearches = 0;

  outer:
  for (const { keyword, location } of indeedQueue) {
    {
      if (state.stopped || state.paused || Date.now() > deadline || applied >= applyCap) break outer;

      // Space the searches out. Skipped before the first so a short run starts immediately, and
      // broken into short sleeps so Stop and Pause stay responsive. The harness sets
      // JOBPILOT_TEST_NO_PACING; nothing in the app does.
      if (indeedSearches > 0 && process.env.JOBPILOT_TEST_NO_PACING !== '1') {
        const until = Date.now() + INDEED_SEARCH_GAP_MS;
        while (Date.now() < until && !state.stopped && !state.paused
               && Date.now() < deadline && applied < applyCap) {
          await sleep(3000);
        }
      }
      indeedSearches++;
      try {
        fs.writeFileSync(indeedOffsetFile, String((indeedOffset + indeedSearches) % indeedPairs.length));
      } catch { /* non-fatal */ }

      state.action = `Searching Indeed "${keyword}" in ${location}`;
      await api.event({ runId: state.runId, portal: 'indeed', type: 'info', detail: state.action });
      await page.goto(searchUrl(keyword, location, profile, 0, maxAgeDays), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await humanDelay(2800, 5000);
      // Signed in? Indeed shows job cards to guests too, but apply needs a session — and the
      // page layout differs, which can silently yield zero cards.
      const url = page.url();
      const loggedOut = /\/account\/login|secure\.indeed\.com|\/hp\?/i.test(url);

      const pstate = await pageState(page);
      // A page we cannot read at all is its own failure mode: the session is wedged, and
      // pretending it returned no jobs produces a run of silent zeros.
      if (pstate === 'unreadable') {
        unreadable++;
        console.log(`  ⚠ ${keyword} · ${location} → the page could not be read (attempt ${unreadable}/3)`);
        if (unreadable >= 3) {
          // RELAUNCH — do not ask the owner to do it by hand.
          //
          // This ended the block and printed "Close the automation browser, reopen JobPilot,
          // and run again", asking a person to perform the one recovery the code can perform
          // itself. The run then sat at 0/0/0 until somebody happened to read the terminal, and
          // today that is exactly what Indeed did: three unreadable pages, block over, nothing
          // applied, no retry.
          //
          // index.js already closes the context, waits for the profile lock to drop, reopens on
          // the same profile and retries the block. That path is tested and has existed for
          // versions — Indeed never reached it because this branch RETURNED instead of throwing.
          // A wedged session is what a dead or blocked context looks like from in here, so
          // throwing is the honest signal as well as the useful one.
          fault('BROWSER_DEAD', { portal: 'indeed', unreadablePages: unreadable, url: page.url() });
          await api.event({ runId: state.runId, portal: 'indeed', type: 'info',
            detail: 'Indeed pages could not be read three times in a row — reopening the browser '
              + 'and retrying this block.' });
          seal(runLedger, { applied, searched: runLedger.seen });
          setLedger(null);
          throw new Error('Target page, context or browser has been closed');
        }
        await sleep(5000);
        continue;
      }
      unreadable = 0;
      if (pstate === 'blocked') {
        blockedStreak++;
        blockedTotal++;
        state.action = 'Indeed checkpoint — needs attention';
        // SAY IT. Both branches below used to emit backend events only, so a walled run
        // printed its plan and then went completely silent — indistinguishable from a hang,
        // and the single most misleading thing this adapter did.
        console.log(`  ⛔ ${keyword} · ${location} → Indeed is showing a checkpoint (${blockedStreak}/3)`);
        // Previously this looped per keyword×location and flooded the activity feed with
        // hundreds of identical errors. Three walls in a row = Indeed is not letting us in
        // this session: flag needs_attention (rings the bell) and END the block cleanly.
        if (blockedStreak >= 3) {
          console.log('     ✋ three checkpoints in a row — ending the Indeed block.');
          console.log('        Open Indeed in the automation browser, solve it once, then run again.');
          await api.event({ runId: state.runId, portal: 'indeed', type: 'error',
            detail: 'checkpoint/captcha persists — pausing Indeed for this block. Solve it in the browser, then run again.' });
          await api.runStatus(state.runId, 'needs_attention', 'Indeed captcha — solve it in the browser').catch(() => {});
          return { applied, blocked: true, ...tally };
        }
        await api.event({ runId: state.runId, portal: 'indeed', type: 'error',
          detail: 'checkpoint/captcha — solve it in the browser, then it resumes' });
        await sleep(15000);
        continue;
      }
      blockedStreak = 0;

      // Walk a few result pages, not just the first. Stop early once a page adds nothing new —
      // that means we've reached the end of the genuinely distinct results for this search.
      const keys = await collectJobKeys(page);
      for (let pg = 1; pg < pagesPerSearch; pg++) {
        if (state.stopped || state.paused || Date.now() > deadline) break;
        const before = keys.length;
        await page.goto(searchUrl(keyword, location, profile, pg * 10, maxAgeDays), { waitUntil: 'domcontentloaded' }).catch(() => {});
        await humanDelay(2200, 4000);
        if ((await pageState(page)) !== 'ok') break;
        for (const k of await collectJobKeys(page)) if (!keys.includes(k)) keys.push(k);
        if (keys.length === before) break;   // nothing new on that page — stop paging
      }
      totalResults += keys.length;
      // "16 result(s)" on every line told us nothing — Indeed pages at ~15, so the count is
      // always about the same, and after the first search they are mostly jobs we already
      // handled. What matters is how many are NEW, because that is what the run can act on.
      const fresh = keys.filter((k) => !doneJobs.has(k));
      const dupeNote = keys.length && !fresh.length ? '  (all already seen this run)'
        : fresh.length < keys.length ? `  · ${fresh.length} new` : '';
      console.log(`  🔎 ${keyword} · ${location} → ${keys.length} result(s)${dupeNote}${keys.length === 0 && loggedOut ? '  ⚠ looks signed-out' : ''}`);
      sawAnyFresh ||= fresh.length > 0;
      if (keys.length === 0 && !diagShown) { diagShown = true; await describeSearch(page).catch(() => {}); }
      await api.event({ runId: state.runId, portal: 'indeed', type: 'info',
        detail: `${keys.length} results for ${keyword} @ ${location}` });

      for (const jk of keys) {
        if (state.stopped || state.paused || Date.now() > deadline || applied >= applyCap) break outer;
        if (doneJobs.has(jk)) continue;   // already handled this run (another city's search)
        doneJobs.add(jk);
        opened++;
        const jobPage = await ctx.newPage();
        try {
          // Open the job IN THE RESULTS PAGE via `vjk`, not as a bare /viewjob deep link.
          //
          // Verified live with the worker's own session: a search returns 16 job keys happily,
          // but every `https://in.indeed.com/viewjob?jk=<key>` came back
          // "Additional Verification Required" — 6 of 6, descriptions empty, no controls. The
          // same six opened perfectly on `/jobs?...&vjk=<key>` (descriptions 1,311–7,160 chars,
          // apply controls present). Indeed treats the deep link as a scrape and the SERP-with-
          // vjk as a person clicking a result, which is also what its own UI does — the search
          // itself redirects to `...&vjk=<key>` when you click a card.
          await jobPage.goto(jobPaneUrl(keyword, location, profile, jk, maxAgeDays),
            { waitUntil: 'domcontentloaded' }).catch(() => {});
          await humanDelay(1800, 3200);
          // A blocked job page used to `continue` in total silence — no log, no event, no
          // counter. With every viewjob behind a captcha the run printed its searches and then
          // appeared to hang forever, which is exactly the "16 results, then nothing" loop.
          if ((await pageState(jobPage)) !== 'ok') {
            blockedJobs++;
            if (blockedJobs === 1) fault('BOT_CHALLENGE', { where: 'job pages', url: page.url() });
            await jobPage.close();
            // Three in a row used to END THE BLOCK. That is the wrong response to this
            // particular signal: verified live, individual job pages open fine (6/6 readable)
            // — Indeed challenges on sustained VOLUME, after a run has opened a dozen-plus
            // pages back to back. It is a throttle, and throttles pass. Quitting threw away
            // the remaining ~70 searches over a wall that clears in a minute, which is why a
            // real run reported "0 applied" while its gate was working perfectly.
            //
            // So: rest, then carry on. Only a wall that survives several rests is a real one.
            if (blockedJobs >= 3) {
              backoffs++;
              if (backoffs > MAX_BACKOFFS) {
                console.log(`     ✋ still blocked after ${MAX_BACKOFFS} pauses — ending the Indeed block.`);
                await api.event({ runId: state.runId, portal: 'indeed', type: 'error',
                  detail: `Indeed kept showing a checkpoint on job pages through ${MAX_BACKOFFS} pauses. Open Indeed in the automation browser, solve it, then run again.` });
                await api.runStatus(state.runId, 'needs_attention', 'Indeed captcha on job pages').catch(() => {});
                seal(runLedger, { applied, searched: runLedger.seen });
  setLedger(null);
  return { applied, ...tally };
              }
              // 1m, 2m, 3m — lengthening, like a person pausing. Collapsed under the test flag,
              // the same way humanDelay is, so the suite does not sit through real minutes.
              const restMs = process.env.JOBPILOT_TEST_NO_PACING === '1' ? 0 : 60_000 * backoffs;
              console.log(`     ⏳ Indeed is throttling job pages — resting ${restMs / 60_000}m, then carrying on (pause ${backoffs}/${MAX_BACKOFFS}).`);
              await api.event({ runId: state.runId, portal: 'indeed', type: 'info',
                detail: `Indeed throttled job pages after ${opened} opened — pausing ${restMs / 60_000}m before continuing.` });
              await sleep(restMs);
              blockedJobs = 0;                    // give the session a clean slate after the rest
            }
            continue;
          }
          blockedJobs = 0;

          const post = await readPosting(jobPage);
          state.action = `Reviewing: ${post.title}`;
          await api.event({ runId: state.runId, portal: 'indeed', type: 'job_identified',
            title: post.title, company: post.company, url: `https://${host}/viewjob?jk=${jk}`,
            salary: post.salary, description: (post.description || '').replace(/\s+/g, ' ').slice(0, 400) });

          if (SENIOR_RE.test(post.title || '')) {
            await api.event({ runId: state.runId, portal: 'indeed', type: 'info',
              title: post.title, company: post.company, detail: 'skip — senior/leadership role' });
            tally.skipped++;
            logSkipped(post.title || 'Role', 'senior/leadership role');
            continue;
          }
          // Same gate LinkedIn uses — one place decides, so the two portals can't disagree.
          const gate = await shouldApply(api, post, plan);
          if (!gate.ok) {
            await api.event({ runId: state.runId, portal: 'indeed',
              type: gate.manual ? 'manual_apply' : 'info', title: post.title, company: post.company,
              url: `https://${host}/viewjob?jk=${jk}`, detail: `skip — ${gate.label}` });
            // A gate refusal that names a MANUAL outcome is a lead, not a discard — counting
            // both as "skipped" is what made a run that produced 40 manual leads report none.
            if (gate.manual) tally.manual++; else tally.skipped++;
            logSkipped(post.title || 'Role', gate.label);
            continue;
          }
          const score = gate.score;
          await api.event({ runId: state.runId, portal: 'indeed', type: 'relevant',
            title: post.title, company: post.company, detail: gate.label });

          logJobHeader(post.title || 'Role', post.company || '', gate.label);
          beginJob();
          await recycleIfBloated(state, ctx);
          const result = await indeedApply(jobPage, api, profile, state, ctx, jk);
          // Pass the REASON through, not just the outcome. This called logResult('attention')
          // with nothing attached, so the terminal printed a bare "Paused — needs your answer"
          // and the ledger recorded "attention: attention" — five pauses in one run with no
          // explanation, sending the owner hunting for a screening question that did not exist.
          // The same fix went into linkedin.js and was never carried here, which is how a fix
          // reported as done stayed broken on half the product.
          logResult(
            result === 'applied' ? 'applied'
              : result === 'external' ? 'external'
              : result === 'attention' ? 'attention' : 'none',
            // BOTH sources. The screening questions live in state.blockedQuestions and the
            // non-question causes in state.attentionReason; v151 read only the latter, so the
            // twelve jobs that paused on a real question reported "attention: attention" and the
            // question itself — the one thing the owner could have acted on — was discarded.
            result === 'attention'
              ? ((state.blockedQuestions || [])[0] || state.attentionReason || undefined)
              : undefined,
          );
          state.attentionReason = null;   // per job, never carried into the next one
          state.blockedQuestions = null;
          if (result === 'applied') {
            applied++;
            await api.event({ runId: state.runId, portal: 'indeed', type: 'easy_apply',
              title: post.title, company: post.company, url: `https://${host}/viewjob?jk=${jk}`, detail: `fit ${score}` });
          } else if (result === 'external') {
            externals++;
            tally.manual++;
            // A genuinely external job is normal. EVERY job being external is a selector fault
            // wearing the same clothes — that is what made Indeed look like it had no Easy
            // Apply jobs at all. Dump the page once so the next run carries the evidence.
            // Terminal shows it once — 82 identical dumps is not a log, it is noise. The FILE
            // records every one, because "1 job had no Apply button" and "82 did" are different
            // problems and the old log could not tell them apart.
            if (externals === 1) {
              console.log('     ⓘ no Indeed Apply button on this job — what the page offers:');
              await describeApplyArea(jobPage).catch(() => {});
            }
            logEvent('job', { portal: 'indeed', outcome: 'external', jk,
              title: post.title || null, url: jobPage.url() });
            await api.event({ runId: state.runId, portal: 'indeed', type: 'manual_apply',
              title: post.title, company: post.company,
              url: `https://${host}/viewjob?jk=${jk}`, detail: `fit ${score} — apply manually (employer site)` });
          } else if (result === 'attention') {
            tally.attention++;
            await api.event({ runId: state.runId, portal: 'indeed', type: 'info',
              title: post.title, company: post.company,
              detail: (state.blockedQuestions || [])[0]
                ? `needs your answer: ${(state.blockedQuestions || [])[0]}`
                : 'needs attention — an unanswerable question' });
          } else {
            // Same silent-drop bug as LinkedIn had: anything that wasn't applied/external
            // emitted NOTHING, so the job disappeared with no counter and no error.
            tally.manual++;
            await api.event({ runId: state.runId, portal: 'indeed', type: 'manual_apply',
              title: post.title, company: post.company,
              url: `https://${host}/viewjob?jk=${jk}`, detail: 'no Indeed Apply button found — apply manually' });
          }
        } catch (e) {
          // A RECYCLE REQUEST IS NOT A FAILED JOB. This catch swallows everything so one bad
          // posting cannot end the block — correct for a posting, fatal for the recycle signal,
          // which has to reach index.js to be acted on. Swallowed here it would have been
          // counted as a failed job and the browser would have gone on growing to the point
          // this exists to prevent. The same applies to a dead browser: index.js relaunches and
          // continues the block, and it can only do that if the error reaches it.
          const msg = String((e && e.message) || e);
          if (msg === RECYCLE_SIGNAL || /target page, context or browser has been closed/i.test(msg)) throw e;
          tally.failed++;
          await api.event({ runId: state.runId, portal: 'indeed', type: 'error', detail: String(e).slice(0, 160) });
        } finally {
          await jobPage.close().catch(() => {});
          await humanDelay(2200, 4200);
        }
      }
    }
  }
  // A run that searched a lot and opened nothing is the failure mode that looked like a hang.
  // Say which of the two it was — no new jobs, or jobs found but never opened.
  if (totalResults > 0 && opened === 0) {
    console.log(`\n  ✋ ${totalResults} listing(s) matched, but none were opened.`);
    console.log(sawAnyFresh
      ? '     Jobs were available — the run ended (time, quota or stop) before reaching them.'
      : '     Every search returned the same postings, all already handled earlier in this run.');
    await api.event({ runId: state.runId, portal: 'indeed', type: 'info',
      detail: `${totalResults} listings matched but none were opened${sawAnyFresh ? '' : ' — all were duplicates of earlier searches'}` });
  } else if (opened > 0) {
    console.log(`\n  Indeed: opened ${opened} job(s), applied to ${applied}, ${externals} employer-site.`);
    // Every single job being "external" is the signature of a broken apply-button selector, not
    // of Indeed genuinely having no in-site applications. Those two look identical in the logs,
    // which is exactly how Indeed came to look like it had never worked.
    if (applied === 0 && externals === opened && opened >= 5) {
      fault('NO_APPLY_BUTTON', { externals, opened });
      console.log('     (was: every job reported no Indeed Apply button — usually a selector');
      console.log('       change on Indeed rather than reality — see the [diag] dump above.');
      await api.event({ runId: state.runId, portal: 'indeed', type: 'error',
        detail: `all ${opened} jobs reported no Indeed Apply button — likely an Indeed layout change rather than genuinely external listings` });
    }
  }
  // If EVERY search returned zero, say why in plain terms rather than a silent 0/0/0/0/0.
  if (totalResults === 0) {
    // A run walled fewer than three times never reached the bail-out above, so it used to
    // finish with the generic "usual causes" list and no needs_attention — the owner was told
    // to guess between three possibilities when the adapter already knew which one it was.
    if (blockedTotal > 0) {
      console.log(`\n  ✋ Indeed showed a checkpoint on ${blockedTotal} of ${kws.length * locs.length} searches — nothing could be read.`);
      console.log('     Open Indeed in the automation browser, solve the check once, then run again.');
      await api.event({ runId: state.runId, portal: 'indeed', type: 'error',
        detail: `Indeed showed a captcha/checkpoint on ${blockedTotal} search(es) — solve it in the automation browser, then run again.` });
      await api.runStatus(state.runId, 'needs_attention', 'Indeed captcha — solve it in the browser').catch(() => {});
    } else {
      console.log('\n  ✋ Indeed returned no jobs for any search. Usual causes:');
      console.log('     · not signed in to Indeed in the automation browser (log in once, then run again)');
      console.log('     · Indeed changed its results markup');
      await api.event({ runId: state.runId, portal: 'indeed', type: 'error',
        detail: 'Indeed returned no jobs — sign into indeed.com in the automation browser, then run again.' });
    }
  }
  return { applied, ...tally };
}

/** Indeed Apply is a multi-step flow that often opens on smartapply.indeed.com. */
/**
 * Find Indeed's OWN apply button — the one that opens the in-site flow — as opposed to an
 * "Apply on company site" link, which we never drive.
 *
 * Matched by what the control SAYS, across the page and any embedded frames. The previous
 * version used four fixed selectors (`#indeedApplyButton`, `.ia-IndeedApplyButton`, …); when
 * none matched, the job was reported as an employer-site listing. That is indistinguishable in
 * the logs from a genuinely external job, so a selector change looked exactly like "Indeed has
 * no Easy Apply jobs" — which is why it appeared never to work.
 */
/**
 * Make sure the JOB PANE is actually open before anything judges what is on it.
 *
 * Evidence from 2026-08-14: 82 jobs were recorded as "apply manually (employer site)", and the
 * diagnostic dump for them lists the page's buttons in full:
 *
 *   Skip to main content | 1 new update | 1 new update | Close | Clear what input |
 *   Clear location input | Find jobs | Pay | Remote | Distance 1 | Job type | Job Language
 *
 * That is the search page's own chrome and nothing else. Not one control from the job panel —
 * no Apply, no Save, no Report job, not even "Apply on company site". The pane had not rendered,
 * so "this job has no Indeed Apply button" was a verdict about a panel that was not on screen.
 * 82 applyable jobs may have been thrown away on it in a single run.
 *
 * Navigating to `?vjk=<key>` usually renders the pane server-side, but evidently not always. So:
 * wait for it, and if it is still absent, CLICK THE CARD — which is what a person does, and what
 * Indeed's own UI does (the search itself rewrites to `&vjk=<key>` on click).
 */
async function ensureJobPane(page, jk) {
  const PANE = 'h2.jobsearch-JobInfoHeader-title, [data-testid="jobsearch-JobInfoHeader-title"], '
    + '#jobDescriptionText, .jobsearch-JobComponent-description';
  const present = async () => !!(await page.$(PANE).catch(() => null));

  if (await present()) return true;
  await page.waitForSelector(PANE, { timeout: 6000 }).catch(() => {});
  if (await present()) return true;

  // Still nothing — click the result card for this job, the way a person would.
  const clicked = await page.evaluate((key) => {
    const card = document.querySelector(`[data-jk="${key}"]`)
      || document.querySelector(`a[href*="${key}"]`);
    if (!card) return false;
    const link = card.matches('a') ? card : card.querySelector('a');
    (link || card).click();
    return true;
  }, jk).catch(() => false);
  if (clicked) {
    await page.waitForSelector(PANE, { timeout: 8000 }).catch(() => {});
    if (await present()) return true;
  }

  // Genuinely absent. Say so with the evidence, rather than calling it an employer-site listing.
  const diag = await page.evaluate(() => ({
    cards: document.querySelectorAll('[data-jk]').length,
    buttons: [...document.querySelectorAll('button, [role="button"]')]
      .map((b) => (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean).slice(0, 14),
  })).catch(() => ({ cards: null, buttons: [] }));
  fault('INDEED_PANE_NOT_RENDERED', { jk, url: page.url(), clickedCard: clicked, ...diag });
  return false;
}

async function findIndeedApplyButton(page) {
  // Indeed renders the Apply widget in an iframe on many layouts, so search frames too.
  const roots = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const root of roots) {
    const fast = await root.$('#indeedApplyButton, .ia-IndeedApplyButton, [data-testid*="indeedApply"], '
      + 'button[aria-label*="Apply now" i], button[aria-label*="Apply with Indeed" i], '
      + '[aria-label*="Apply with Indeed" i]').catch(() => null);
    if (fast && await fast.isVisible().catch(() => false)) return fast;

    const handles = await root.$$('button, a[role="button"], div[role="button"]').catch(() => []);
    for (const h of handles) {
      const label = await h.evaluate((n) => (
        (n.getAttribute('aria-label') || '') + ' ' + (n.innerText || '')
      ).replace(/\s+/g, ' ').trim().toLowerCase()).catch(() => '');
      if (!label) continue;
      // "Apply on company site" / "Apply on employer site" are the ones to leave alone.
      if (/company site|employer site|company website/.test(label)) continue;
      // "APPLY WITH INDEED" is the label Indeed actually uses, and it matched none of the
      // previous alternatives — "indeed apply" is not "apply with indeed". Verified live: of
      // six real job pages, two offered `Apply with Indeed opens in a new tab` and both were
      // reported as employer-site listings and skipped. That single missing phrase is why
      // Indeed submitted nothing while appearing to have no applyable jobs at all.
      if (/^apply now$|^apply$|easily apply|indeed apply|apply with indeed/.test(label)) {
        if (await h.isVisible().catch(() => false)) return h;
      }
    }
  }
  return null;
}

/** What buttons a job page actually offers — printed once when no apply button is found. */
async function describeApplyArea(page) {
  const info = await page.evaluate(() => ({
    url: location.href,
    frames: document.querySelectorAll('iframe').length,
    buttons: [...document.querySelectorAll('button, a[role="button"]')].slice(0, 12)
      .map((b) => (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean),
  })).catch(() => null);
  if (!info) { console.log('     [diag] could not read the apply area'); return; }
  console.log(`     [diag] ${info.url}`);
  console.log(`     [diag] iframes: ${info.frames} · buttons: ${info.buttons.join(' | ') || '(none)'}`);
}

/**
 * Is the APPLY page usable? 'ok' | 'blocked' | 'unreadable', with evidence.
 *
 * `pageState` above judges SEARCH pages, and its healthy signal is `hasResults` — job cards on
 * the page. An apply form has no job cards by definition, so every apply page fell through to
 * the challenge heuristics, and any page it could not evaluate came back 'unreadable'. Indeed's
 * apply flow opens in a NEW TAB and redirects through smartapply.indeed.com, so an evaluate
 * fired too early throws on a destroyed execution context — reported as "the apply page was
 * blocked or unreadable" and the job abandoned. That reason accounted for 13 of one run's 24
 * pauses, with nothing recorded to tell a real block from a page that simply had not arrived.
 *
 * So this waits for the tab to settle, retries, judges by whether a FORM is present, and
 * returns the evidence either way.
 */
async function applyPageState(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const sig = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width >= 120 && r.height >= 120 && getComputedStyle(el).visibility !== 'hidden';
      };
      const widget = [...document.querySelectorAll(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[title*="captcha" i],'
        + ' iframe[title*="challenge" i], #challenge-form, #challenge-running, .g-recaptcha,'
        + ' .h-captcha, [data-testid="captcha"], form[action*="challenge"]')].some(visible);
      return {
        title: (document.title || '').slice(0, 120),
        text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 2000),
        widget,
        // The apply flow's own evidence: any control you could fill or press. This is what
        // `hasResults` should have been for this page.
        controls: document.querySelectorAll(
          'input, select, textarea, button, [role="button"]').length,
      };
    }).catch(() => null);
    last = sig;
    if (sig && sig.controls > 0 && !sig.widget) return { state: 'ok', sig };
    if (sig && sig.widget) return { state: 'blocked', sig };
    if (sig && CHALLENGE_RE.test(sig.text.toLowerCase())) return { state: 'blocked', sig };
    // Nothing to act on yet — the tab is probably still redirecting. Give it a moment.
    await humanDelay(900, 1500);
  }
  return { state: last ? 'unreadable' : 'unreadable', sig: last };
}

// Exported for testing. The apply flow is the part that has never worked, and driving the
// whole of runIndeed to reach it takes minutes per assertion — slow enough that it was
// never actually done, which is how the new-window bug survived 140 passing tests.
/**
 * Ask for a fresh browser when memory passes the limit.
 *
 * Measured, not guessed: an abandoned application window costs ~204 MB, the machine has ~5 GB
 * free, and ~25 of them exhaust it — which is about 50 minutes of work and exactly the window in
 * which the browser has been dying. Closing the windows (which now happens on every path) is
 * necessary but not sufficient: after closing twelve, 1.7 GB of the 2.4 GB never came back.
 * Firefox keeps it, so the only way to give it back is to restart the browser.
 *
 * Raised BETWEEN jobs, never inside one — index.js catches it, relaunches, and re-enters the
 * block with `state` intact, so the phase budget and the search position carry over.
 */
async function recycleIfBloated(state, ctx) {
  // Scoped to the browser this run owns — see browserMemoryMB. 0 means it could
  // not be measured, and an unmeasurable number must never trigger a restart.
  const mb = await browserMemoryMB(ctx).catch(() => 0);
  if (!mb) return;                                   // unmeasurable platform — never block on it
  const free = freeMemoryMB();
  state.lastBrowserMB = mb;

  // Recycling only helps if the browser is the one holding the memory. When it is small and the
  // machine is still short, the pressure is something else on the desktop, and restarting our
  // browser would achieve nothing except a loop of restarts on every job.
  const worthRecycling = mb > 800;
  const tooBig = mb >= BROWSER_MEMORY_LIMIT_MB;
  const tooLittleLeft = free <= FREE_MEMORY_FLOOR_MB && worthRecycling;
  if (!tooBig && !tooLittleLeft) return;

  logEvent('lifecycle', { event: 'recycle requested', memoryMB: mb, freeMB: free,
    reason: tooBig ? 'browser over limit' : 'machine low on memory' });
  console.log(`
     ♻ the automation browser is using ${(mb / 1024).toFixed(1)} GB and `
    + `${(free / 1024).toFixed(1)} GB is free — restarting it before there is no room to.`);
  throw new Error(RECYCLE_SIGNAL);
}

export async function indeedApply(page, api, profile, state, ctx, jk) {
  // The pane FIRST. Without this, "no Indeed Apply button on this job" was being decided
  // against the search page's own chrome — see ensureJobPane for what that actually looked
  // like. A missing pane is not an employer-site listing, and must not be recorded as one.
  if (!(await ensureJobPane(page, jk))) {
    state.attentionReason = 'the job panel never opened, so the Apply button could not be found';
    return 'attention';
  }
  const btn = await findIndeedApplyButton(page);
  if (!btn) return 'external';

  state.action = 'Indeed Apply…';
  const before = new Set(ctx.pages());
  await btn.click({ timeout: 4000 }).catch(() => {});

  // FIND THE APPLICATION WINDOW. This is what you were watching go wrong.
  //
  // The old code raced `ctx.waitForEvent('page')` against the click with a 6-second timeout and
  // fell back to `page` when it expired. Indeed opens the application in a SEPARATE WINDOW that
  // often takes longer than that to appear — so the window opened, we never attached to it, and
  // we spent twelve steps driving the SEARCH page instead. The log proves it: the flow "ended"
  // at https://in.indeed.com/jobs offering "Find jobs | Pay | Remote | Distance | Job type",
  // which is search chrome, while the real application sat in a window we had walked away from.
  // And because we never held a handle to it, we never closed it — so every job left another
  // window open on screen, which is exactly what you saw piling up.
  //
  // Poll instead of racing: up to 20 seconds, for a page that is NEW, or for this page having
  // been navigated into the apply flow. Indeed serves it from smartapply / m5.apply, and both
  // the new-window and same-window shapes are covered.
  const isApplyUrl = (u) => /smartapply|m5\.apply|\/applystart|indeedapply|\/apply\b/i.test(String(u || ''));
  let applyPage = null;
  for (let i = 0; i < 20 && !applyPage; i++) {
    for (const p of ctx.pages()) {
      if (p.isClosed && p.isClosed()) continue;
      if (!before.has(p)) { applyPage = p; break; }                    // a window that is new
      if (p === page && isApplyUrl(p.url())) { applyPage = p; break; } // flow took over this page
    }
    if (!applyPage) await sleep(1000);
  }
  if (!applyPage) applyPage = page;
  await humanDelay(1800, 3200);
  logEvent('job', { portal: 'indeed', step: 'apply-window',
    separateWindow: applyPage !== page, url: applyPage.url() });
  let lastUrl = applyPage.url();
  let lastButtons = [];

  // EVERY exit closes the application window.
  //
  // Three of the returns below are early ones — paused, blocked, unanswerable question — and
  // none of them closed it. Only the submit and the run-out-of-steps paths did. So a run that
  // paused on twenty jobs left twenty application windows open, each holding a tab, memory and
  // a share of the browser's stability. That is both the pile of windows on screen and a very
  // plausible contributor to the browser dying: this is a persistent context, and nothing was
  // ever reclaiming those pages.
  //
  // A finally block cannot be added around a function that returns from inside a loop without
  // restructuring it, so the loop body is wrapped and the cleanup happens once, here.
  try {
    return await applySteps();
  } finally {
    if (applyPage !== page && applyPage.isClosed && !applyPage.isClosed()) {
      await applyPage.close().catch(() => {});
    }
    // Sweep anything else the flow spawned — Indeed sometimes opens an interstitial of its own.
    // The job page and the main page stay; everything past them is ours to reclaim.
    for (const p of ctx.pages()) {
      if (p === page || p === applyPage) continue;
      if (p.isClosed && p.isClosed()) continue;
      if (!before.has(p)) await p.close().catch(() => {});
    }
  }

  async function applySteps() {

  for (let step = 0; step < 12; step++) {
    if (state.paused) { state.attentionReason = 'the run was paused'; return 'attention'; }
    const health = await applyPageState(applyPage);
    if (health.state !== 'ok') {
      // Say WHICH, and carry what was on screen. "blocked or unreadable" covered two opposite
      // situations — a real challenge to solve, and a tab that had not finished loading — and
      // told the owner to go looking for a screening question in both.
      state.attentionReason = health.state === 'blocked'
        ? 'Indeed showed a security check on the apply page'
        : 'the apply page never finished loading';
      fault(health.state === 'blocked' ? 'INDEED_APPLY_BLOCKED' : 'INDEED_APPLY_UNREADABLE', {
        url: applyPage.url(),
        title: health.sig?.title || null,
        controls: health.sig?.controls ?? null,
        sample: (health.sig?.text || '').slice(0, 160),
      });
      return 'attention';
    }

    // Same rule as LinkedIn: observe which resume Indeed has attached, record it, submit anyway.
    // Indeed serves its own hosted resume, which has no filename to match against at all, so a
    // guard demanding our filename back could never pass here either.
    const attached = await observeResume(applyPage).catch(() => ({ attached: false, name: null }));
    state.resumeName = attached.name;
    const { attention } = await fillForm(applyPage, profile, api);
    // Indeed's screening step is radio-group based too — fillForm skips those.
    const { attention: choiceAttention } = await fillChoices(applyPage, api);
    // Custom dropdowns — pick the closest option from what the dropdown offers.
    const { attention: dropAttention } = await fillDropdowns(applyPage, profile, api);
    attention.push(...choiceAttention, ...dropAttention);
    if (attention.length) {
      // Name it. "needs attention — an unanswerable question" without the question is the same
      // diagnostic gap that hid LinkedIn's real bug for three rounds: it reads as a screening
      // question nobody can answer when it may be a control we simply failed to fill.
      state.blockedQuestions = attention;
      return 'attention';
    }

    // Wider than `button:has-text("Submit application")`. Indeed labels the final control
    // several ways across its flows — "Submit application", "Submit your application", a bare
    // "Submit", and on some steps an <input type=submit> rather than a button. The old selector
    // required either the exact phrase or type=submit AND the word Submit, so anything else
    // fell through to the Continue matcher, failed that too, and ended the flow as "no submit
    // step" — which is what 11 of one run's 24 pauses were.
    const submit = await applyPage.$(
      'button:has-text("Submit application"), button:has-text("Submit your application"), '
      + 'button[type="submit"]:has-text("Submit"), input[type="submit"], '
      + '[data-testid*="submit" i], button[aria-label*="Submit" i]');
    if (submit) {
      await submit.click({ timeout: 4000 }).catch(() => {});
      await humanDelay(1500, 2600);
      // WAIT for the confirmation rather than glancing once. Indeed navigates to it, and a
      // single check 1.5s after the click regularly runs before the page has arrived.
      const done = await applyPage.waitForSelector(
        'text=/application submitted|your application has been submitted|applied on/i',
        { timeout: 12000 }).catch(() => null);
      if (done) return 'applied';
      // `return done ? 'applied' : 'applied'` — both branches were 'applied', so the check was
      // decorative: the flow claimed success whether or not Indeed ever confirmed it. Nothing
      // had reached this line yet (Indeed has submitted nothing), but the moment the window
      // handling works it would have started reporting unverified sends as applications, and
      // the count the owner reads would have been fiction.
      //
      // The click HAS happened, so the application may well be in. Reporting 'attention' would
      // send it again next run. So: still 'applied', but recorded as unconfirmed, which keeps
      // the number honest and reviewable instead of silently wrong.
      fault('INDEED_SUBMIT_UNCONFIRMED', {
        url: applyPage.url(),
        text: await applyPage.evaluate(() => (document.body?.innerText || '')
          .replace(/\s+/g, ' ').trim().slice(0, 180)).catch(() => ''),
      });
      return 'applied';
    }
    const cont = await applyPage.$('button:has-text("Continue"), button[aria-label*="Continue"], button:has-text("Next")');
    if (cont) { await cont.click({ timeout: 4000 }).catch(() => {}); await humanDelay(1200, 2200); continue; }
    // About to give up: record what the page offered, while the page still exists. Read after
    // the close below and it is gone — which is why this branch has never carried evidence.
    lastUrl = applyPage.url();
    lastButtons = await applyPage.$$eval('button, [role="button"], input[type=submit]',
      (els) => els.map((e) => ((e.innerText || e.value || e.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ').trim())).filter(Boolean).slice(0, 12)).catch(() => []);
    break;
  }
  // The catch-all. Reaching here means the flow ran out of steps without submitting and without
  // any earlier branch explaining why — so say THAT, rather than printing a bare "needs your
  // answer" that sends the owner looking for a screening question that may not exist. Five of
  // today's pauses came through here with nothing recorded at all.
  if (!state.attentionReason) {
    state.attentionReason = 'the apply flow ended without a submit step (no question was blocking it)';
  }
  // 11 of one run's 24 pauses came through here and recorded NOTHING about the page — so
  // "there was no Submit button" could not be distinguished from "the button is called
  // something we do not match". The buttons that WERE there settle it in one line.
  fault('INDEED_NO_SUBMIT_STEP', { url: lastUrl, buttons: lastButtons });
  return 'attention';
  }
}
