// LinkedIn adapter. Drives LinkedIn's native **Easy Apply** on the owner's logged-in
// session. Searches with the Easy-Apply filter (f_AL=true) so we only open jobs we can
// actually one-click apply to, walks the multi-step Easy Apply modal, answers screening
// questions from the profile/AI, and (optionally) sends a connection request afterward.
// Conservative by design — human delays, caps, stop-on-pause; never touches external
// "Apply on company website" links.
import { humanDelay, sleep } from '../browser.js';
import { fillForm, fillChoices, fillDropdowns, uploadResume } from '../fill.js';
import { logSearch, logJobHeader, logSkipped, logResult, logSummary, beginJob } from '../log.js';
import { sendConnectionRequests, checkAcceptances, sendApprovedMessages, sendFollowUps } from './outreach.js';
import { shouldApply, shouldContact, claimOutreach } from '../gate.js';
import { cleanupDue, withdrawStaleInvites } from '../invites.js';

// Seniority is filtered here because LinkedIn's own filters don't reliably exclude it. The
// COMPATIBILITY decision does not live in this file — `gate.js → shouldApply` owns it, so
// LinkedIn and Indeed cannot drift apart. (This used to carry a FIT_THRESHOLD of 25 on keyword
// overlap; that is what let a Python role through to a Java résumé.)
const SENIOR_RE = /\b(senior|sr\.?|lead|principal|staff|architect|manager|director|head\s+of|vp|vice\s*president)\b/i;

// LinkedIn pages at 25 results and offsets with `start`. Reading only page 1 capped every
// search at 25 regardless of how many matches existed.

function searchUrl(keyword, location, start = 0, maxAgeDays = 0) {
  const p = new URLSearchParams({ keywords: keyword, f_AL: 'true', sortBy: 'DD' }); // f_AL = Easy Apply only
  if (location && location.toLowerCase() !== 'remote') p.set('location', location);
  else p.set('f_WT', '2'); // remote
  if (start > 0) p.set('start', String(start));
  // f_TPR=r<seconds> — "posted within". Keeps months-old, almost certainly filled postings out.
  if (maxAgeDays > 0) p.set('f_TPR', `r${Math.round(maxAgeDays * 86400)}`);
  return `https://www.linkedin.com/jobs/search/?${p.toString()}`;
}

/**
 * The URL that actually renders a job's detail pane.
 *
 * NOT `/jobs/view/<id>/`. Verified against live LinkedIn with a signed-in session: that page
 * still returns 200 and still puts the role in `document.title`, but its body renders no <h1>,
 * no top card, no `#job-details` and no Easy Apply button — every selector this adapter needs
 * is absent. Reading it produced exactly the symptom a real run showed: a job "loaded", then a
 * blank title, an empty description and "no Easy Apply button".
 *
 * The search route with `currentJobId` renders the full pane. Same live check, same job id:
 *   /jobs/view/4440944244/            -> h1 [], top cards 0, #job-details false, no button
 *   /jobs/search/?…&currentJobId=…    -> h1 ["Staff Software Engineer"], 10 top cards,
 *                                        #job-details true, "Easy Apply" present
 * Keeping the search context also means the pane opens the way it does for a person browsing
 * results, rather than as a bare deep link.
 */
function jobPaneUrl(keyword, location, id, maxAgeDays = 0) {
  const p = new URLSearchParams({ keywords: keyword, f_AL: 'true', sortBy: 'DD' });
  if (location && location.toLowerCase() !== 'remote') p.set('location', location);
  else p.set('f_WT', '2');
  if (maxAgeDays > 0) p.set('f_TPR', `r${Math.round(maxAgeDays * 86400)}`);
  p.set('currentJobId', String(id));
  return `https://www.linkedin.com/jobs/search/?${p.toString()}`;
}

const CARD_SELECTOR =
  'li[data-occludable-job-id], div.job-card-container[data-job-id], li.jobs-search-results__list-item, [data-job-id]';

async function waitForResults(page) {
  await page.waitForSelector(CARD_SELECTOR, { timeout: 18000 }).catch(() => {});
  await page.waitForTimeout(1200).catch(() => {});
}

async function collectJobCards(page) {
  // The results rail; ids live on the <li> or a data attribute. Also grab the title + company
  // from the CARD itself — the detail pane sometimes hasn't rendered when we read it, and we
  // never want to log a job with no role. LinkedIn changes these classes often, so cast wide.
  const cards = await page.$$eval(CARD_SELECTOR, (nodes) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    /**
     * Collapse a string that is exactly itself twice, and strip LinkedIn's badge suffixes.
     * "Software EngineerSoftware Engineer" → "Software Engineer".
     * "Staff Engineer ( Backend ) Staff Engineer ( Backend ) with verification" → "Staff Engineer ( Backend )".
     */
    const dedupe = (s) => {
      let v = (s || '').replace(/\s*with verification\s*$/i, '').trim();
      const half = v.length / 2;
      if (v.length % 2 === 0 && v.slice(0, half) === v.slice(half)) return v.slice(0, half).trim();
      // The two halves may be separated by a space: "Foo Foo".
      const m = v.match(/^(.{4,}?)\s+\1$/);
      return m ? m[1].trim() : v;
    };
    return nodes.map((n) => {
      const id = n.getAttribute('data-occludable-job-id') || n.getAttribute('data-job-id')
        || (n.querySelector('[data-job-id]') && n.querySelector('[data-job-id]').getAttribute('data-job-id'));
      const t = n.querySelector('.job-card-list__title, .job-card-list__title--link, .artdeco-entity-lockup__title, a.job-card-container__link');
      const c = n.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, .job-card-container__company-name');
      // LinkedIn renders the title TWICE — a visible span plus a visually-hidden copy for
      // screen readers — so textContent returned "Software EngineerSoftware Engineer". Prefer
      // the aria-hidden (visible) span; `dedupe` catches the cases where neither is marked.
      const vis = t && t.querySelector('[aria-hidden="true"]');
      const rawTitle = t && (vis ? vis.textContent : (t.getAttribute('aria-label') || t.textContent));
      return { id, title: dedupe(clean(rawTitle)), company: dedupe(clean(c && c.textContent)) };
    }).filter((x) => x.id);
  }).catch(() => []);
  // Dedup by id AND by title+company. LinkedIn lists the same role many times under different
  // job ids (promoted slots, reposts) — the "Full-stack app developer @ Kefilo" that appeared
  // ~20× in one search was 20 distinct ids for one posting. Id-only dedup let it through and
  // the worker ground the same job over and over. Collapse reposts to one.
  const seenId = new Set();
  const seenRole = new Set();
  const out = [];
  for (const c of cards) {
    if (seenId.has(c.id)) continue;
    seenId.add(c.id);
    const roleKey = ((c.title || '') + '|' + (c.company || '')).toLowerCase().replace(/\s+/g, ' ').trim();
    if (roleKey !== '|' && seenRole.has(roleKey)) continue; // same role, different id → skip
    if (roleKey !== '|') seenRole.add(roleKey);
    out.push(c);
  }
  return out;
}

async function readPosting(page) {
  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => '');
  // The TOP-CARD title has the same screen-reader duplication as the result cards: a visible
  // span plus a visually-hidden copy. `text()` above concatenates both, which is where
  // "Java Backend DeveloperJava Backend Developer" came from — and because the pane title
  // overrides the (correctly de-duplicated) card title, the doubled one is what got logged,
  // sent to the fit gate and written to the dashboard. Same rule as collectJobCards: prefer
  // the visible span, then collapse an exact self-repeat.
  // $$eval, not $eval: the FIRST element matching this list is often an empty <h1> LinkedIn
  // renders above the pane, and $eval takes only that one and returns "". Verified live on a
  // signed-in session — 4 of 6 job panes read a blank title this way while the role sat in a
  // later h1. Walk the candidates and take the first that actually has text.
  const title = await page.$$eval(
    '.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, h1',
    (els) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      for (const e of els) {
        const vis = e.querySelector('[aria-hidden="true"]');
        const v = clean(vis ? vis.textContent : e.textContent).replace(/\s*with verification\s*$/i, '');
        if (!v) continue;
        const half = v.length / 2;
        if (v.length % 2 === 0 && v.slice(0, half) === v.slice(half)) return v.slice(0, half).trim();
        const m = v.match(/^(.{4,}?)\s+\1$/);
        return m ? m[1].trim() : v;
      }
      return '';
    },
  ).catch(() => '');
  // Salary is sparse on LinkedIn — scan the top-card "insight" pills for a pay pattern.
  const salary = await page.$$eval(
    '.job-details-jobs-unified-top-card__job-insight, .jobs-unified-top-card__job-insight',
    (els) => {
      for (const el of els) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (/[₹$€£]\s?\d|\d[\d,.]*\s*(per|\/)\s*(year|yr|hour|hr|month|annum)|lpa|\bk\/yr\b/i.test(t)) return t.slice(0, 90);
      }
      return '';
    }).catch(() => '');
  // The description is what the compatibility gate judges on, so an empty one means the job is
  // skipped as "no description to judge" — which is exactly what happened to a whole run when
  // these class names went stale. Try the known containers, then fall back to the LARGEST text
  // block in the details pane, which survives any rename.
  let description = await text('#job-details, .jobs-description__content, .jobs-box__html-content, '
    + '[class*="jobs-description"], .jobs-details__main-content [class*="description"]');
  if (description.replace(/\s+/g, ' ').trim().length < 80) {
    description = await page.evaluate(() => {
      const pane = document.querySelector(
        '.jobs-details, .jobs-search__job-details, [class*="jobs-details"], main');
      if (!pane) return '';

      // "The biggest block of prose" is NOT good enough on its own, and getting that wrong is
      // expensive rather than merely untidy. A job pane also contains "About the company",
      // "Meet the hiring team", "Similar jobs" and the premium insight panels. On a staffing
      // or consultancy posting the About panel is LONGER than the job description and is
      // entirely recruitment/HR/onboarding prose — so the largest block was handed to the fit
      // gate, the model judged the job to require recruitment and HR skills, and every posting
      // came back "stack mismatch (fit 0) — missing recruitment, HR, onboarding" against a
      // backend role. Exclude the panels we know about, by container AND by heading.
      const BAD_CONTAINER = /jobs-company|company-module|hirer-card|people-who-can-help|similar-job|jobs-similar|people-also-viewed|insight|premium|jobs-search-results|salary/i;
      const BAD_HEADING = /^(about the company|meet the hiring team|similar jobs|people also viewed|more jobs|how your profile matches|salary)/i;

      const excluded = (el) => {
        for (let n = el; n && n !== pane; n = n.parentElement) {
          const id = `${n.id || ''} ${n.className || ''}`;
          if (typeof n.className === 'string' && BAD_CONTAINER.test(id)) return true;
          // A <section> whose own heading names it as a neighbour panel.
          const h = n.querySelector && n.querySelector(':scope > h1, :scope > h2, :scope > h3');
          if (h && BAD_HEADING.test((h.innerText || '').trim())) return true;
        }
        return false;
      };

      let best = '';
      for (const el of pane.querySelectorAll('div, section, article, p')) {
        if (el.querySelector('div, section, article, p')) continue;   // leaves only
        if (excluded(el)) continue;
        const t = (el.innerText || '').trim();
        if (t.length > best.length) best = t;
      }
      // Below this it is not a job description, and an honest empty string is worth more than a
      // confident wrong one: gate.js turns it into "no description to judge" → a manual lead,
      // rather than a fabricated verdict about the job.
      return best.replace(/\s+/g, ' ').trim().length >= 200 ? best : '';
    }).catch(() => '');
  }

  return {
    title,
    company: await text('.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name'),
    location: await text('.job-details-jobs-unified-top-card__primary-description-container, .jobs-unified-top-card__bullet'),
    description,
    salary,
  };
}

// The job detail pane — used both to confirm a job actually loaded and to scroll the top card
// (where the Easy Apply button lives) into view.
//
// The exact-class list below is LinkedIn's naming as we last saw it, and they rename these
// regularly — when they did, EVERY job reported "job page would not load" and the whole block
// produced nothing. The `[class*=...]` entries survive a rename because LinkedIn keeps the stem
// ("jobs-unified-top-card-v2" still contains "jobs-unified-top-card"), and `jobLoaded()` below
// is the real authority: it judges by CONTENT, which no rename can take away.
const PANE_SEL = [
  '.job-details-jobs-unified-top-card', '.jobs-unified-top-card', '.jobs-details',
  '.jobs-search__job-details', '.jobs-details__main-content', '#job-details',
  '[class*="jobs-unified-top-card"]', '[class*="job-details"]', '[class*="jobs-search__job-details"]',
].join(', ');

/**
 * Did a job page actually load? Judged by what's on it, not by class names: a real job page has
 * a heading and a body of text, or an Apply button. This is what stops a LinkedIn redesign from
 * silently turning every job into a skip.
 */
async function jobLoaded(page) {
  return page.evaluate(() => {
    const txt = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    if (/sign in|join now to see/i.test(txt.slice(0, 400))) return false;   // authwall
    const heading = [...document.querySelectorAll('h1, h2')]
      .some((h) => (h.innerText || '').trim().length > 3);
    const applyish = [...document.querySelectorAll('button, a')]
      .some((b) => /easy apply|apply now|^apply$/i.test((b.innerText || '').trim()));
    return (heading && txt.length > 400) || applyish;
  }).catch(() => false);
}

/**
 * Is the pane on screen actually the job we asked for?
 *
 * A job page "loading" is not the same as the RIGHT job page loading. LinkedIn's SPA leaves the
 * previous posting rendered when a navigation or card click doesn't take, so `jobLoaded()`
 * happily returns true for a page describing a different role entirely — and every downstream
 * step (title, description, fit verdict, Easy Apply) then refers to the wrong job while naming
 * the right one. The id appears in the URL and in the apply control's tracking attributes, so
 * check for it before believing anything on the page.
 */
async function paneShowsJob(page, id) {
  return page.evaluate((jobId) => {
    if (location.href.includes(jobId)) return true;
    const inDom = document.querySelector(
      `[data-job-id="${jobId}"], [data-occludable-job-id="${jobId}"], `
      + `[data-jobid="${jobId}"], a[href*="${jobId}"]`);
    return !!inDom;
  }, String(id)).catch(() => false);
}

/** Print what a job page really is when it won't load — once, not 57 times. */
async function describeJobPage(page) {
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title.slice(0, 90),
    h1: (document.querySelector('h1')?.innerText || '').trim().slice(0, 80),
    topCards: document.querySelectorAll('[class*="jobs-unified-top-card"], [class*="job-details"]').length,
    buttons: [...document.querySelectorAll('button')].slice(0, 8)
      .map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 220),
  })).catch(() => null);
  if (!info) { console.log('     [diag] could not read the job page'); return; }
  console.log(`     [diag] ${info.url}`);
  console.log(`     [diag] title: ${info.title} · h1: "${info.h1}"`);
  console.log(`     [diag] job-detail containers: ${info.topCards} · buttons: ${info.buttons.join(' | ')}`);
  console.log(`     [diag] text: ${info.text}`);
}

/**
 * Are we actually signed in? This matters more than it looks: LinkedIn's GUEST job search
 * still returns a full page of job cards, so a signed-out run looks like a working run —
 * hundreds "found", hundreds "relevant". But guest job pages use a different DOM (so the
 * description reads empty and no fit can be scored) and carry NO Easy Apply button at all,
 * only "Sign in to apply". That is exactly the "190 found / 0 applied" signature, and
 * grinding through 190 jobs to discover it one-by-one is pointless — check once, up front.
 */
async function ensureLoggedIn(page, api, state) {
  // The AUTH COOKIE is the source of truth. The previous check looked for specific nav CSS
  // classes ('global-nav__me-photo' …); LinkedIn renames those, so a perfectly signed-in
  // session was reported as signed OUT and every run aborted. li_at is what actually decides.
  const cookies = await page.context().cookies('https://www.linkedin.com').catch(() => []);
  if (cookies.some((c) => c.name === 'li_at' && c.value)) return true;

  // No cookie — confirm with the page itself before accusing the user of being logged out.
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanDelay(1500, 2600);
  const authwalled = /\/login|\/authwall|\/signup|\/uas\/login/i.test(page.url());
  // Any of these means a logged-in chrome is rendering; don't depend on one class name.
  const me = await page.$('[data-control-name="identity_welcome_message"], .global-nav__me, .global-nav, #global-nav, a[href*="/in/"]');
  if (!authwalled && me) return true;
  await api.event({
    runId: state.runId, portal: 'linkedin', type: 'error',
    detail: 'Not signed in to LinkedIn. The signed-out job search still lists jobs, but those pages '
      + 'have no Easy Apply button — nothing can be applied to. Open the automation browser, log into '
      + 'linkedin.com once (the session is remembered), then run again.',
  });
  return false;
}

export async function runLinkedIn(page, api, plan, state, ctx) {
  // Bail out loudly rather than "successfully" processing 190 unapplyable guest pages.
  if (!(await ensureLoggedIn(page, api, state))) return { applied: 0 };

  const profile = await api.profile().catch(() => ({}));
  const resume = await api.resume().catch(() => ({ hasResume: false }));
  // A LinkedIn run lasts ~3h unless you stop it. The 180-minute floor is enforced HERE, not
  // just server-side: an old schedule row with a short duration made the deadline expire during
  // Phase 1, so Phase 2 was skipped and the block ended right after applying — exactly the
  // "it stopped midway / never got to the post analysis" case.
  // Durations come from Automation → Schedule (apply mins + outreach mins).
  const blockMin = Math.max(plan.blockMinutes || 210, 30);
  const deadline = Date.now() + blockMin * 60_000;
  let applied = 0;
  const tally = { manual: 0, attention: 0, failed: 0, skipped: 0 };

  const mode = plan.mode || 'all';
  // Per-run apply cap comes from the gear setting (default 15). Phase 1 also gets AT MOST one
  // hour: if it can't hit the cap in that time it stops applying and moves to outreach.
  // applyCap is what's LEFT of today's quota (the backend subtracts what already went out),
  // so an unfinished quota automatically rolls into the next run.
  const applyCap = plan.applyCap ?? 15;
  const maxAgeDays = plan.maxAgeDays || 0;   // skip postings older than this
  let paneFailures = 0;                      // consecutive job pages that would not render
  const pagesPerSearch = Math.max(1, plan.pagesPerSearch || 3);
  const dailyTarget = plan.dailyTarget || applyCap;
  const doneToday = plan.appliedToday || 0;
  const phase1Deadline = Date.now() + Math.max(plan.phase1Minutes || 90, 5) * 60_000;
  // WHY Phase 1 ended. Only two reasons are meant to stop it — the time budget and the daily
  // application cap — and for weeks it was being ended by neither, with nothing in the log
  // saying so. Every exit now names itself, so "it stopped early" is answerable from the
  // terminal instead of from a database.
  let phase1End = 'every search was exhausted';
  // Jobs already handled THIS RUN. LinkedIn returns the same posting in every city search, so
  // without this the worker re-opened and re-answered the same job 5-6 times (the HeadSpin /
  // Jobgether rows repeating in Hyderabad, Chennai, Remote, Mumbai…) and burned the hour on
  // duplicates instead of reaching new jobs.
  const doneJobs = new Set();

  // ── Easy Apply — the first of the four flows. ──
  // `easyApplyOn` is honoured HERE. It used to be read nowhere at all: Phase 1 ran off
  // linkedinApplyMins while the switch and budget in the flow settings were dead, so turning
  // Easy Apply off changed nothing. The flow settings are now the only source.
  const easyApplyOff = (plan.flowConfig || {}).easyApply?.on === false;
  if (easyApplyOff) console.log('\n  ⏭  Easy Apply — switched off in Schedule');
  if (!easyApplyOff && mode !== 'outreach' && applyCap > 0) {
    api.flow = 'easyApply';                     // tags this phase's events
    console.log(`\n  ══ Easy Apply — ${doneToday}/${dailyTarget} done today, ${applyCap} to go (max ${plan.phase1Minutes || 90}m) ══`);
    // An empty plan makes the loops below no-ops, so the phase prints its header and then
    // nothing at all — indistinguishable from a broken search. Say which side is empty.
    if ((plan.keywords || []).length === 0 || (plan.locations || []).length === 0) {
      console.log(`  ✋ Nothing to search: ${(plan.keywords || []).length} term(s), ${(plan.locations || []).length} location(s).`);
      console.log('     Add target roles and locations in Automation → Setup, then run again.');
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'error',
        detail: `LinkedIn had nothing to search — ${(plan.keywords || []).length} keyword(s) and ${(plan.locations || []).length} location(s). Set target roles and locations in Setup.` });
    }
    outer:
    for (const keyword of plan.keywords) {
      for (const location of plan.locations) {
        if (state.stopped || state.paused || Date.now() > phase1Deadline || applied >= applyCap) {
          phase1End = state.stopped ? 'the run was stopped'
            : state.paused ? 'paused'
            : applied >= applyCap ? `the daily cap of ${applyCap} applications was reached`
            : `the ${plan.phase1Minutes || 90}-minute Easy Apply budget ran out`;
          break outer;
        }

      state.action = `Opening LinkedIn Easy-Apply search: "${keyword}" in ${location}`;
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: state.action });
      await page.goto(searchUrl(keyword, location, 0, maxAgeDays), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForResults(page);

      const cards = await collectJobCards(page);
      // Walk further result pages. collectJobCards already collapses reposts, so the stop
      // condition is "this page added nothing new", the same rule Indeed uses.
      const seenIds = new Set(cards.map((c) => c.id));
      for (let pg = 1; pg < pagesPerSearch; pg++) {
        if (state.stopped || state.paused || Date.now() > phase1Deadline) break;
        await page.goto(searchUrl(keyword, location, pg * 25, maxAgeDays), { waitUntil: 'domcontentloaded' }).catch(() => {});
        await waitForResults(page);
        const more = (await collectJobCards(page)).filter((c) => !seenIds.has(c.id));
        if (more.length === 0) break;
        for (const c of more) { seenIds.add(c.id); cards.push(c); }
      }
      const landed = page.url();
      const needsLogin = /\/login|\/authwall|signup/i.test(landed);
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
        detail: cards.length > 0
          ? `Found ${cards.length} Easy-Apply jobs for "${keyword}" @ ${location}`
          : needsLogin
            ? `LinkedIn asked to log in — sign into linkedin.com in the browser, then run again`
            : `No Easy-Apply results on this search — LinkedIn may have changed the page or need login` });
      logSearch(keyword, location, cards.length);
      if (cards.length === 0) continue;

      for (const cardInfo of cards) {
        const id = cardInfo.id;
        if (state.stopped || state.paused || Date.now() > phase1Deadline || applied >= applyCap) {
          phase1End = state.stopped ? 'the run was stopped'
            : state.paused ? 'paused'
            : applied >= applyCap ? `the daily cap of ${applyCap} applications was reached`
            : `the ${plan.phase1Minutes || 90}-minute Easy Apply budget ran out`;
          break outer;
        }
        // Skip anything already handled in this run (same posting, different city search).
        const roleKey = ((cardInfo.title || '') + '|' + (cardInfo.company || '')).toLowerCase().replace(/\s+/g, ' ').trim();
        if (doneJobs.has(id) || (roleKey !== '|' && doneJobs.has(roleKey))) continue;
        doneJobs.add(id);
        if (roleKey !== '|') doneJobs.add(roleKey);
        // Declared HERE, not inside the try: the catch below reports on them, and if the job
        // failed before they were assigned the catch itself threw "title is not defined" and
        // took the whole run down with it.
        let title = cardInfo.title || '';
        let company = cardInfo.company || '';
        try {
          // Open the job on ITS OWN URL, not by clicking the card.
          //
          // The results rail is virtualised — `data-occludable-job-id` is LinkedIn telling us
          // it only renders cards that are on screen. We collect every id up front, so from
          // roughly the fifteenth card onward the element is a hollow placeholder: clicking it
          // does nothing, the SPA never swaps the pane, and the loop then reads whatever job
          // was already displayed. That is where a run of blank titles carrying confident
          // verdicts came from — "skipped: stack mismatch (fit 30) — missing Payment
          // Processing" was a real judgement, just not about the job it was filed against.
          // Navigating is slower than clicking and is worth it: a wrong verdict is worse than
          // a slow one.
          await page.goto(jobPaneUrl(keyword, location, id, maxAgeDays), { waitUntil: 'domcontentloaded' }).catch(() => {});
          let pane = await page.waitForSelector(PANE_SEL, { timeout: 8000 }).then(() => true).catch(() => false);
          // The selectors are a hint; the CONTENT decides. A renamed container must not turn a
          // perfectly good job page into a skip.
          if (!pane) pane = await jobLoaded(page);
          // …and the content must be THIS job. Without this check the pane simply has to look
          // like a job page, which the previous job's pane also does.
          if (pane && !(await paneShowsJob(page, id))) {
            // LinkedIn often IGNORES currentJobId and renders whichever job it feels like —
            // usually the first result. Treating that as a dead page cost five strikes and
            // ended Phase 1 outright, which is why a search that found 57 jobs processed a
            // handful and stopped. It is not a broken page; it is the wrong job on a working
            // one, and the fix is to ask for the right one the way a person would: click its
            // card in the results list.
            const card = await page.$(`li[data-occludable-job-id="${id}"], div[data-job-id="${id}"]`);
            if (card) {
              await card.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await card.click({ timeout: 3000 }).catch(() => {});
              await page.waitForTimeout(2200).catch(() => {});
            }
            if (!(await paneShowsJob(page, id))) {
              pane = false;
              if (paneFailures === 0) {
                console.log(`     ⚠ the pane would not switch to job ${id} — skipping it rather than judging another job's text.`);
              }
            }
          }
          if (!pane) {
            paneFailures++;
            // Diagnose once with evidence, instead of repeating the same guess 57 times.
            if (paneFailures === 1) {
              console.log('     ⚠ the job page did not render as expected — dumping what is actually there:');
              await describeJobPage(page).catch(() => {});
              await api.event({ runId: state.runId, portal: 'linkedin', type: 'error',
                url: `https://www.linkedin.com/jobs/view/${id}/`,
                detail: 'job pages are not rendering — LinkedIn layout change or a signed-out session. See the terminal for the page dump.' });
            }
            // Every job failing the same way is one fault, not 57. Stop and say so.
            if (paneFailures >= 15) {
              console.log(`\n  ✋ ${paneFailures} job pages in a row would not load — ending Phase 1.`);
              console.log('     Usually: the LinkedIn session expired, or LinkedIn changed the job page.');
              await api.event({ runId: state.runId, portal: 'linkedin', type: 'error',
                detail: `${paneFailures} job pages in a row failed to load — stopping Easy Apply. Check you are signed into linkedin.com in the automation browser.` });
              phase1End = `${paneFailures} job pages in a row would not load`;
              break outer;
            }
            continue;
          }
          paneFailures = 0;   // a page loaded — the streak is broken
          await humanDelay(1200, 2400);

          const post = await readPosting(page);
          // Fall back to the card's title/company if the detail pane didn't render — never log a
          // "Role"/"Company" blank.
          title = post.title || cardInfo.title || '';
          company = post.company || cardInfo.company || '';

          // A job with NO title read from either the pane or the card was not really open, and
          // whatever description came back belongs to something else. The last run filed a
          // whole column of blank-titled rows carrying verdicts like "missing Payment
          // Processing, Clearing Systems" — each one a real judgement about a posting nobody
          // could identify. Refuse to judge it; keep it as a lead so the job isn't lost.
          if (!title.trim()) {
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'manual_apply',
              company, url: `https://www.linkedin.com/jobs/view/${id}/`,
              detail: 'could not read this posting — open it by hand' });
            tally.manual++;
            logSkipped('(untitled posting)', 'could not read it — left for manual');
            continue;
          }
          state.action = `Reviewing: ${title}`;
          await api.event({ runId: state.runId, portal: 'linkedin', type: 'job_identified',
            title, company, url: `https://www.linkedin.com/jobs/view/${id}/`,
            salary: post.salary, description: (post.description || '').replace(/\s+/g, ' ').slice(0, 400) });

          if (SENIOR_RE.test(title)) {
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
              title, company, detail: 'skip — senior/leadership role' });
            tally.skipped++; logSkipped(title, 'senior/leadership role');
            continue;
          }
          // The compatibility gate: résumé-aware, and it must pass on BOTH score and stack.
          const gate = await shouldApply(api, post, plan);
          if (!gate.ok) {
            // A job we can't judge isn't discarded — it becomes a manual lead, so a thin
            // description costs you a click rather than an unseen opportunity.
            await api.event({ runId: state.runId, portal: 'linkedin',
              type: gate.manual ? 'manual_apply' : 'info', title, company,
              url: `https://www.linkedin.com/jobs/view/${id}/`, detail: `skip — ${gate.label}` });
            if (gate.manual) tally.manual++; else tally.skipped++;
            logSkipped(title, gate.label);
            continue;
          }
          const score = gate.score;
          await api.event({ runId: state.runId, portal: 'linkedin', type: 'relevant',
            title, company, detail: gate.label });

          logJobHeader(title || 'Role', company || '', gate.label);
          beginJob(); // reset per-job de-duplication of the field rows below
          state.blockedQuestions = null;
          const result = await easyApply(page, api, profile, resume, state);
          if (result === 'applied') {
            applied++;
            logResult('applied');
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'easy_apply',
              title, company, url: `https://www.linkedin.com/jobs/view/${id}/`, detail: `fit ${score}` });
          } else if (result === 'external') {
            // No Easy Apply → the owner applies by hand; recorded as manual_apply so the
            // dashboard lists it and the daily digest emails it.
            tally.manual++;
            logResult('external');
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'manual_apply',
              title, company,
              url: `https://www.linkedin.com/jobs/view/${id}/`, detail: `fit ${score} — apply manually (external form)` });
          } else if (result === 'attention') {
            tally.attention++;
            const blocked = (state.blockedQuestions || [])[0];
            logResult('attention', blocked);
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
              title, company, detail: blocked ? `needs your answer: ${blocked}` : 'needs attention — an unanswerable question' });
          } else {
            // 'none'. The search is Easy-Apply-filtered (f_AL=true), so EVERY result genuinely
            // has an Easy Apply button — reaching here means the button didn't render for us,
            // not that the job lacks one. Surface it honestly (it used to emit nothing at all,
            // which is why the board showed hundreds relevant with 0 of everything).
            tally.manual++;
            logResult('none');
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'manual_apply',
              title, company, url: `https://www.linkedin.com/jobs/view/${id}/`,
              detail: 'Easy Apply form did not open for this job — open it and apply manually' });
          }
        } catch (e) {
          tally.failed++;
          logResult('failed', String(e.message || e).slice(0, 80));
          // apply_failed (with the job identity) — a REAL per-job failure, so the dashboard's
          // "Failed" tile counts jobs that broke while applying, not every transient hiccup
          // ("page wouldn't load", a 502) which stays a plain 'error' and isn't shown as failed.
          await api.event({ runId: state.runId, portal: 'linkedin', type: 'apply_failed',
            title, company, url: `https://www.linkedin.com/jobs/view/${id}/`,
            detail: String(e.message || e).slice(0, 160) });
        }
        await humanDelay(2000, 4000);
      }
    }
    }
  }

  api.flow = null;   // Easy Apply is done; the next three tag themselves.

  // Close Phase 1 out loud. "0 applied" with no explanation is what made a run that was
  // being killed from outside look identical to one that simply found nothing.
  {
    const usedMin = Math.round((Date.now() - (phase1Deadline - Math.max(plan.phase1Minutes || 90, 5) * 60_000)) / 60000);
    console.log(`
  ══ Easy Apply finished after ${usedMin}m of ${plan.phase1Minutes || 90}m — ${phase1End} ══`);
    console.log(`     ${applied}/${applyCap} applications this run`);
    await api.event({ runId: state.runId, portal: 'linkedin', flow: 'easyApply', type: 'info',
      detail: `Easy Apply ended after ${usedMin}m of ${plan.phase1Minutes || 90}m — ${phase1End}. `
            + `${applied}/${applyCap} applications.` }).catch(() => {});
  }

  // ── The remaining three flows. ──
  if (!state.stopped && !state.paused && Date.now() < deadline) {
    if (applyCap === 0) console.log(`\n  ✓ Today's ${dailyTarget} LinkedIn applications are already done — all remaining time goes to outreach.`);
    // Each has its OWN time budget and switch. They used to be one undifferentiated "Phase 2",
    // so "outreach isn't working" could mean any of three things and there was no way to run
    // only the one you cared about.
    const flows = plan.flowConfig || {};
    const remaining = () => Math.max(0, deadline - Date.now());

    /** Run one flow inside its own budget, tagging everything it emits. */
    const runFlow = async (key, fn) => {
      const cfg = flows[key] || {};
      const label = cfg.label || key;
      if (cfg.on === false) { console.log(`\n  ⏭  ${label} — switched off in Schedule`); return; }
      if (state.stopped || state.paused || remaining() <= 0) return;
      // Never let one flow eat the whole block: its budget, capped by what's left overall.
      const budgetMs = Math.min((cfg.mins ?? 30) * 60_000, remaining());
      if (budgetMs <= 0) { console.log(`\n  ⏭  ${label} — no time left in this block`); return; }

      const flowPlan = { ...plan, flow: key, blockMinutes: Math.ceil(budgetMs / 60_000) };
      const started = Date.now();
      console.log(`\n  ══ ${label} — up to ${Math.round(budgetMs / 60_000)}m ══`);
      api.flow = key;                                  // tags every event this flow emits
      try {
        await fn(flowPlan);
      } catch (e) {
        console.log(`     ${label} ended: ${String(e).slice(0, 140)}`);
        await api.event({ runId: state.runId, portal: 'linkedin', flow: key, type: 'info',
          detail: `${label} ended early: ${String(e).slice(0, 140)}` });
      } finally {
        api.flow = null;
        console.log(`     ${label} took ${Math.round((Date.now() - started) / 60000)}m`);
      }
    };

    // 2. Post scan → apply. Reads hiring posts and routes each to a manual link, a message, or
    //    an email (see scanHiringPosts). This is where new leads come from.
    await runFlow('postApply', (p) => scanHiringPosts(page, api, p, state, true, resume));

    if (plan.autoMessage === false) {
      console.log('\n  ⏭  Auto-message is OFF — enable it on the Connections page to send invites + messages');
    } else {
      // 3. Email-only: harvest recruiter addresses and send. scanHiringPosts already emails any
      //    address it meets; this pass exists so email outreach can be run (or switched off) on
      //    its own, independently of messaging.
      await runFlow('emailOutreach', (p) => scanHiringPosts(page, api, { ...p, emailOnly: true }, state, true, resume));

      // 4. Connections: grow reach — invite or message verified recruiters, pick up acceptances,
      //    then the staged follow-ups. Follow-ups run last so a fresh invite from this same block
      //    isn't followed up an hour later.
      await runFlow('connections', async (p) => {
        // Free capacity BEFORE spending it. LinkedIn counts pending invitations against the
        // weekly limit, so an account carrying months of unanswered requests simply stops
        // being offered Connect — which is what happened here at 155 outstanding. Weekly, and
        // only invitations old enough to be dead weight; see invites.js for how timid this is.
        if (cleanupDue()) {
          await withdrawStaleInvites(page, api, state, {
            olderThanDays: p.withdrawAfterDays,
            max: p.withdrawMax,
          }).catch((e) => console.log(`     invitation cleanup skipped: ${String(e).slice(0, 90)}`));
        }
        await sendConnectionRequests(page, api, p, state, resume);
        await checkAcceptances(page, api, state);
        await sendApprovedMessages(page, api, resume, state);
        await sendFollowUps(page, api, resume, state, p);
      });
    }
  }
  return { applied, ...tally };
}

// ---- Phase 1: hiring-post scan → HR email extraction ------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Obvious non-recruiter addresses — never lead on these.
const EMAIL_JUNK = /no-?reply|example\.|linkedin\.com|\.png$|\.jpe?g$|\.gif$|support@|help@|info@linkedin/i;

// A URL in a hiring post that is an actual way to apply, rather than a company homepage or a
// link back into LinkedIn. Matching the well-known ATS hosts is far more reliable than trying
// to judge an arbitrary domain, and a false negative just means the post routes to a message
// instead — which is still a valid outcome.
const APPLY_HOSTS =
  /(lever\.co|greenhouse\.io|workday(?:jobs)?\.com|myworkdayjobs\.com|smartrecruiters\.com|ashbyhq\.com|jobvite\.com|icims\.com|taleo\.net|successfactors\.com|bamboohr\.com|recruitee\.com|workable\.com|zohorecruit\.com|freshteam\.com|keka\.com|darwinbox\.com|naukri\.com|instahyre\.com|cutshort\.io|wellfound\.com|angel\.co|forms\.gle|docs\.google\.com\/forms|typeform\.com|airtable\.com)/i;
const CAREERS_PATH = /\/(careers?|jobs?|apply|openings|vacanc)/i;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** The application link in a post, or '' when there isn't a usable one. */
function findApplyLink(text) {
  const urls = (text || '').match(URL_RE) || [];
  for (const raw of urls) {
    const u = raw.replace(/[.,;:)]+$/, '');           // strip trailing sentence punctuation
    if (/linkedin\.com/i.test(u)) continue;           // a link back into LinkedIn isn't an apply link
    if (APPLY_HOSTS.test(u)) return u;
  }
  // Second pass: any non-LinkedIn URL whose PATH looks like a careers/apply page.
  for (const raw of urls) {
    const u = raw.replace(/[.,;:)]+$/, '');
    if (/linkedin\.com/i.test(u)) continue;
    try { if (CAREERS_PATH.test(new URL(u).pathname)) return u; } catch { /* not a URL */ }
  }
  return '';
}

/**
 * Search LinkedIn CONTENT (posts) for each keyword, scroll a few pages, and pull
 * recruiter emails out of hiring posts. Each email goes to the backend as a lead with
 * the post text, so the engine can tailor + auto-email an application. Time-boxed and
 * capped so it never eats the Easy Apply phase.
 */
async function scanHiringPosts(page, api, plan, state, dedicated = false, resume = null) {
  // Dedicated outreach phase (after the apply quota) is UNCAPPED on leads — it scans every
  // keyword, scrolls deep, and keeps harvesting until the block's time runs out.
  const cap = dedicated ? Infinity : 8;
  const scrolls = dedicated ? 25 : 4;
  // How many posts to READ. The old scan had no target at all, so "150 analysed" was whatever
  // happened to fall out of the scroll loop rather than a goal it was working towards.
  const target = dedicated ? (plan.postScanTarget || 150) : 40;
  const phaseDeadline = Date.now() + (dedicated ? (plan.blockMinutes || 120) * 60_000 : 8 * 60_000);
  let found = 0;
  let analysed = 0;
  let hiringPosts = 0;   // posts classified as real openings (no email needed)
  const seen = new Set();
  // Every analysed post lands in exactly ONE of these. Reporting them together is the
  // difference between "scanned 150 → 0 emails" and knowing what actually happened.
  const routed = { email: 0, message: 0, manual: 0, notHiring: 0, skipped: 0 };
  console.log(`\n  🔎 Scanning hiring posts — target ${target} post(s) this block…`);

  for (const keyword of plan.keywords.slice(0, dedicated ? plan.keywords.length : 3)) {
    if (state.stopped || state.paused || Date.now() > phaseDeadline || found >= cap) break;
    if (analysed >= target) break;   // today's reading target is met
    state.action = `Scanning LinkedIn posts: "${keyword} hiring"`;
    await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: state.action });

    const url = 'https://www.linkedin.com/search/results/content/?keywords='
      + encodeURIComponent(`${keyword} hiring`) + '&sortBy=%22date_posted%22';
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await humanDelay(2500, 4000);
    if (/\/login|\/authwall|signup/i.test(page.url())) {
      // Never return silently here: this is the single most common reason outreach produces
      // no emails, and with no event the dashboard just showed nothing at all.
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'error',
        detail: 'post search hit LinkedIn’s login wall — sign into linkedin.com in the automation browser, then run again' });
      return;
    }

    let analysedHere = 0;   // posts read for THIS keyword (the cumulative one is `analysed`)
    for (let scroll = 0; scroll < scrolls && found < cap && analysed < target && Date.now() < phaseDeadline; scroll++) {
      // read every post currently rendered
      // Class-independent: try the known post containers, but if LinkedIn has renamed them
      // (which is why this reported "scanned 0 posts"), fall back to the WHOLE PAGE as one
      // blob — we only need the text to mine recruiter emails out of it.
      const posts = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        let els = [...document.querySelectorAll(
          'div.feed-shared-update-v2, li.artdeco-card, [data-urn*="activity"], [data-id*="activity"], div[data-view-name*="feed"]')];
        if (els.length === 0) {
          // LinkedIn has rewritten content search: every semantic class above is gone and the
          // markup now carries hashed names ("_6d0b28b9 _8342bca6 …") that change on deploy.
          // Verified live on a signed-in session — those selectors matched 0 elements while the
          // page was showing recruiter posts perfectly well.
          //
          // The old fallback returned the WHOLE PAGE as a single post with no name and no
          // author URL, so the message route (which needs post.authorUrl) could never fire and
          // only a stray address anywhere in the body would route. That is why a scan could
          // report posts analysed and produce nothing at all.
          //
          // Identify by CONTENT instead, which no rename can break: an element holding a
          // profile link and a post-sized block of text. Keep only the innermost such elements
          // so a card isn't counted again as part of its container.
          const cands = [...document.querySelectorAll('[componentkey], div, li, article')]
            .filter((e) => {
              const t = e.innerText || '';
              return t.length > 150 && t.length < 6000 && e.querySelector('a[href*="/in/"]');
            });
          els = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)));
        }
        if (els.length === 0) return [];
        return els.slice(0, 40).map((el) => {
          const a = el.querySelector('a[href*="/feed/update/"], a[href*="/posts/"]');
          const nameEl = el.querySelector('.update-components-actor__title span[aria-hidden], .update-components-actor__title, a[href*="/in/"]');
          const authorA = el.querySelector('a[href*="/in/"]');
          const authorUrl = authorA ? (authorA.href || '').split('?')[0] : '';
          let name = clean(nameEl?.textContent).slice(0, 60);
          // The actor-title class is hashed on the rewritten page too, so on 3 of 5 live posts
          // this came back empty — and an unnamed contact makes for a "Hi ," message. The card
          // text opens with "Feed post <Name> • <degree> <headline>", so read it from there.
          if (!name) {
            const m = clean(el.innerText).match(/^(?:feed post\s+)?([^•|]{2,60}?)\s*•/i);
            if (m) name = m[1].trim().slice(0, 60);
          }
          // "Amit Kuveskar • 3rd+" style leftovers — drop the degree marker if it survived.
          name = name.replace(/\s*•.*$/, '').replace(/\s*\b\d(?:st|nd|rd|th)\+?\b\s*$/i, '').trim();
          return { name, link: a?.href || '',
                   authorUrl: /\/in\//.test(authorUrl) ? authorUrl : '',
                   text: (el.innerText || '').slice(0, 4500) };
        });
      }).catch(() => []);
      analysed += posts.length;
      analysedHere += posts.length;

      for (const post of posts) {
        const emails = [...new Set((post.text.match(EMAIL_RE) || []).filter((e) => !EMAIL_JUNK.test(e)))];

        // ROUTE 2 & 3 — no email in the post. Classify the intent once, then send it down the
        // right path instead of discarding it:
        //   · an application/careers link in the text → MANUAL (you click it; we can't fill it)
        //   · otherwise the author's profile          → MESSAGE (outreach contacts them)
        // Most recruiters never put an address in the text, which is why an email-only scan
        // read 150 posts and produced nothing.
        // In email-only mode a post without an address is simply not this flow's business —
        // the post-scan flow already routed it to a message or a manual link.
        if (emails.length === 0 && plan.emailOnly) { routed.notHiring++; continue; }

        if (emails.length === 0 && found < cap) {
          const key = post.authorUrl || post.link;
          if (!key || seen.has(key)) continue;
          const intent = await api.postIntent(post.text).catch(() => ({ isHiring: false }));
          if (!intent.isHiring || (intent.confidence ?? 0) < (plan.personConfMin ?? 80)) {
            routed.notHiring++;
            seen.add(key);
            continue;
          }
          seen.add(key);
          hiringPosts++;
          const applyLink = findApplyLink(post.text);

          if (applyLink) {
            // A form or careers page. Nothing here can fill an arbitrary external form, so
            // pretending otherwise would lose the opportunity silently — it becomes a manual
            // lead with the link, and lands in the daily manual-apply digest.
            routed.manual++;
            console.log(`     🔗 ${post.name || 'someone'} — apply link: ${applyLink.slice(0, 60)}`);
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'manual_apply',
              title: intent.role || 'Hiring post', company: '', url: applyLink,
              detail: `${post.name || 'author'} posted an application link — apply manually` });
          } else if (post.authorUrl) {
            // SECOND WALL. Until now the post classifier was the ONLY thing between a
            // misjudgement and a real person being contacted: this route called upsertContact
            // directly, so one wrong verdict was one wrong message. Post text and author are
            // different evidence — a post can read as hiring while its author's own headline
            // says "Open to work" — and `shouldContact` already rejects those headlines and
            // weighs the post as evidence. Two independent checks, both of which must pass.
            const person = await shouldContact(
              api, { name: post.name, headline: post.headline || '' }, plan, [post.text]);
            if (!person.ok) {
              routed.notHiring++;
              console.log(`     ⊘ ${post.name || 'someone'} — not contacting: ${person.reason}`);
            } else {
              routed.message++;
              await api.upsertContact({
                portal: 'linkedin', name: post.name, profileUrl: post.authorUrl,
                company: '', role: intent.role || 'hiring post author',
                sourceJobUrl: post.link || undefined,
              }).catch(() => {});
              console.log(`     📣 ${post.name || 'someone'} is hiring — ${intent.topic || intent.role || 'an opening'}`);
            }
          }
          await api.event({ runId: state.runId, portal: 'linkedin', type: 'post_analysed',
            title: intent.role || 'Hiring post', url: post.link || post.authorUrl,
            detail: `${post.name || 'author'} — ${intent.topic || 'posted an opening'} (${intent.confidence}% sure)` });
          continue;
        }

        // ROUTE 1 — an address is in the post: email it directly, no connection needed.
        for (const email of emails) {
          if (seen.has(email.toLowerCase()) || found >= cap) continue;
          seen.add(email.toLowerCase());

          // Claim the PERSON before mailing them, passing both identifiers. This is what stops
          // the same recruiter being emailed from one post and messaged from another: the claim
          // records the address, so the messaging flow's later check finds them.
          // SECOND WALL, same reasoning as the message route. claimOutreach answers "have we
          // already, and are we within limits" — NOT "is this a person worth contacting". An
          // address scraped from a jobseeker's own post would sail straight through it.
          const person = await shouldContact(
            api, { name: post.name, headline: post.headline || '' }, plan, [post.text]);
          if (!person.ok) {
            routed.skipped++;
            console.log(`     ⊘ ${email} — not emailing: ${person.reason}`);
            continue;
          }

          const claim = await claimOutreach(api, {
            portal: 'linkedin', company: '', role: post.name || 'hiring post',
            recruiterUrl: post.authorUrl || '', recruiterName: post.name || '',
            email, channel: 'email', resumeVersion: resume?.filename || '',
          });
          if (!claim.ok) {
            routed.skipped++;
            console.log(`     ⊘ ${email} — ${claim.reason}`);
            continue;
          }

          state.action = `HR email found: ${email}`;
          const r = await api.hrLead({
            portal: 'linkedin', email, name: post.name,
            url: post.link || page.url(),
            title: post.text.split('\n').find((l) => l.trim().length > 10)?.slice(0, 90) || 'hiring post',
            postText: post.text,
          }).catch(() => ({ ok: false }));
          if (r.ok && !r.duplicate) {
            found++;
            routed.email++;
            console.log(`     ✉ ${email}  →  ${r.applying ? 'mailing a tailored note + résumé' : 'saved (auto-email off / post too short)'}`);
            await api.event({ runId: state.runId, portal: 'linkedin', type: r.applying ? 'email_sent' : 'info',
              title: `HR lead: ${email}`, url: post.link || undefined,
              detail: r.applying ? 'tailoring application — will auto-email when ready' : 'lead saved (auto-email off or post too short)' });
          }
        }
      }
      await page.mouse.wheel(0, 2400).catch(() => {});
      await humanDelay(2200, 3800);
    }
    // Surface the outreach phase per keyword — otherwise a scan that finds no recruiter
    // email is indistinguishable from a scan that never ran.
    await api.event({ runId: state.runId, portal: 'linkedin', type: 'post_analysed',
      detail: `scanned ${analysedHere} hiring post(s) for “${keyword}” — ${found} recruiter email(s) so far` });
  }
  // Grouped by what each post BECAME. "scanned 150 → 0 emails" told you nothing about whether
  // the scan was working; this says exactly where every hiring post went.
  const pct = target > 0 ? Math.min(100, Math.round((analysed / target) * 100)) : 100;
  console.log(`\n     📊 Posts analysed: ${analysed}/${target} (${pct}% of today's target)`);
  console.log(`        ✉  ${routed.email} emailed directly (address in the post)`);
  console.log(`        💬 ${routed.message} queued to message (author is hiring)`);
  console.log(`        🔗 ${routed.manual} apply links → manual list`);
  console.log(`        ·  ${routed.notHiring} not actually hiring`);
  if (routed.skipped) console.log(`        ⊘  ${routed.skipped} already contacted (limit or duplicate)`);
  if (analysed < target && !state.stopped && !state.paused) {
    console.log(`        (short of target — the block ran out of time or LinkedIn ran out of posts)`);
  }
  await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
    detail: `post scan: ${analysed}/${target} analysed — ${routed.email} emailed, `
      + `${routed.message} to message, ${routed.manual} manual link(s), ${routed.notHiring} not hiring` });
  return routed;
}

/** Walk LinkedIn's multi-step Easy Apply modal. Returns applied|external|attention|none. */
let easyApplyDiagShown = false;
async function easyApply(page, api, profile, resume, state) {
  // The search is Easy-Apply-only (f_AL=true), so the detail pane WILL have an Easy Apply
  // button once it finishes loading. The pane loads async after the card click, so poll for
  // the button for a few seconds before giving up — otherwise a slow render was being
  // misread as "no Easy Apply" and the job wrongly pushed to the manual list.
  // Selector list kept broad: LinkedIn renames these classes often, and the aria-label is
  // "Easy Apply to <role> at <company>" on current markup. Missing the button here is not a
  // cosmetic bug — it silently costs you the application.
  const btn = await findEasyApplyButton(page);
  if (!btn) {
    // Only call it external when there's an EXPLICIT off-site apply control — never on a
    // loose "Apply" match (that false-positive was sending real Easy-Apply jobs to manual).
    const ext = await page.$('button[aria-label*="Apply on company"], a[aria-label*="Apply on company"], a.jobs-apply-button[href^="http"]');
    if (ext) return 'external';
    // We reached "none" on an Easy-Apply-filtered search, i.e. the button we KNOW is there
    // didn't turn up for us. Instead of a dead-end "did not render", print what the page
    // actually is, so the next run shows the real cause (authwall? still loading? renamed
    // control?) instead of leaving us to guess selectors blind.
    await describeApplyArea(page).catch(() => {});
    return 'none';
  }
  state.action = 'Easy Apply — opening the form';
  await btn.click({ timeout: 4000 }).catch(() => {});
  await humanDelay(1500, 2800);

  let modalSeen = false;
  for (let step = 0; step < 12; step++) {
    if (state.paused) { await closeModal(page); return 'attention'; }
    const modal = await page.$('.jobs-easy-apply-modal, [data-test-modal][role="dialog"]');
    if (!modal) break;
    modalSeen = true;

    // Narrate each step so the live feed caption shows the Easy Apply progressing.
    state.action = `Easy Apply — step ${step + 1} (filling the form)`;
    // EVERYTHING scoped to `modal`: the fill helpers must not touch the search header behind it.
    await uploadResume(page, resume, modal).catch(() => {});
    const { attention } = await fillForm(page, profile, api, modal);
    // Screening questions are mostly radio groups, which fillForm skips — answer them too,
    // otherwise the step can never validate and Submit never appears.
    const { attention: choiceAttention } = await fillChoices(page, api, modal);
    // Custom dropdowns (non-native <select>) — pick the closest option from what the dropdown
    // actually offers. Without this a required dropdown stays empty and the form won't submit.
    const { attention: dropAttention } = await fillDropdowns(page, profile, api, modal);
    attention.push(...choiceAttention, ...dropAttention);
    if (attention.length) {
      // an unanswerable question — don't submit a half-filled application. Remember WHICH
      // question(s) blocked it so the result line can name them.
      state.blockedQuestions = attention;
      await closeModal(page);
      return 'attention';
    }

    // Submit if we can; otherwise advance. Matched by what the control SAYS, not by an exact
    // aria-label.
    //
    // These were `button[aria-label="Submit application"]` and
    // `button[aria-label="Continue to next step"]` — exact string equality. LinkedIn ships
    // "Submit", "Review", "Review your application" and "Next" depending on the step and the
    // A/B bucket, so one different word meant neither matched, the loop fell through to the
    // bail-out below, and the job was reported as "needs your answer" — with NO question,
    // because none had blocked it. A real run filled every field on three good matches (fit 80,
    // 70, 80), answered eight screening questions on one of them, and then reported all three
    // as needing attention. Nothing was wrong with those applications except this selector.
    // Match INSIDE the page in one pass, then click by index.
    //
    // The per-handle version of this (loop handles, evaluate a label, test a regex, check
    // isVisible) failed to match a Submit button that the diagnostic printed as present and
    // on-screen in the same breath — three good applications were reported as "needs your
    // answer" because of it. Doing the whole match in one page-side evaluation removes the
    // handle round-trips entirely, and the index it returns refers to the same NodeList the
    // click uses.
    const pickIndex = async (source) => modal.$$eval('button, [role="button"]', (ns, src) => {
      const re = new RegExp(src);
      for (let i = 0; i < ns.length; i++) {
        const n = ns[i];
        const label = ((n.getAttribute('aria-label') || '') + ' ' + (n.innerText || ''))
          .replace(/\s+/g, ' ').trim().toLowerCase();
        if (!label || !re.test(label)) continue;
        // Only what a person could actually click: a real box, not a hidden step.
        const r = n.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden') return i;
      }
      return -1;
    }, source).catch(() => -1);

    const clickIndex = async (i) => {
      const handles = await modal.$$('button, [role="button"]').catch(() => []);
      if (!handles[i]) return false;
      await handles[i].click({ timeout: 4000 }).catch(() => {});
      return true;
    };

    const submitAt = await pickIndex('^submit application|^submit\b|submit application');
    if (submitAt >= 0 && await clickIndex(submitAt)) {
      state.action = 'Easy Apply — submitting';
      await humanDelay(1500, 2600);
      await dismissPostSubmit(page);
      return 'applied';
    }
    // "Review" comes before Submit on the last step; treat it as another advance.
    const nextAt = await pickIndex('continue to next step|review your application|^continue\b|^next\b|^review\b');
    if (nextAt >= 0 && await clickIndex(nextAt)) {
      state.action = `Easy Apply — step ${step + 1} done, continuing`;
      await humanDelay(1200, 2200); continue;
    }

    // No recognisable control. Say what the modal actually offers — the previous silence here
    // is what disguised a selector miss as an unanswerable question for three good matches.
    if (!easyApplyDiagShown) {
      easyApplyDiagShown = true;
      const seen = await modal.$$eval('button, [role="button"]', (ns) => ns
        .map((n) => {
          const label = ((n.getAttribute('aria-label') || '') + ' ' + (n.innerText || '')).replace(/\s+/g, ' ').trim();
          const r = n.getBoundingClientRect();
          const shown = r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden';
          return label ? `${label}${shown ? '' : ' [hidden]'}` : '';
        })
        .filter(Boolean).slice(0, 10)).catch(() => []);
      console.log('     ⚠ the Easy Apply form has no Submit/Continue control we recognise.');
      console.log(`     [diag] step ${step + 1}, buttons: ${seen.join(' | ') || '(none)'}`);
    }
    await closeModal(page);
    return 'attention';
  }
  // The modal DID open (we clicked Easy Apply and saw it) but we ran out of steps without a
  // Submit — a long/looping form we couldn't finish. That is NOT "button didn't render"; say so.
  if (modalSeen) { await closeModal(page); return 'attention'; }
  return 'none';
}

/**
 * Find the Easy Apply button robustly.
 *
 * The button is React-rendered and LinkedIn renames its CSS classes constantly, so a fixed
 * class list goes stale silently. The most stable handle is the ACCESSIBLE ROLE + NAME
 * ("Easy Apply"), which is contractually stable because screen-reader users depend on it —
 * that survives class renames. We wait for it to actually appear (it hydrates after the pane
 * skeleton, which is why an early check saw nothing), scrolling the top card in between.
 *
 * Guarded to the top card / apply container so a "Easy Apply" mention elsewhere on the page
 * (e.g. a "you can Easy Apply to jobs like this" promo) can't be mistaken for the control.
 */
async function findEasyApplyButton(page) {
  const byRole = page.getByRole('button', { name: /easy apply/i });
  const cssFallback = page.locator([
    'button.jobs-apply-button',
    '.jobs-apply-button--top-card button',
    'button[aria-label*="Easy Apply" i]',
    '[data-live-test-job-apply-button]',
  ].join(', '));

  for (let i = 0; i < 6; i++) {
    // Role-based first: it's the resilient one.
    const r = byRole.first();
    if (await r.count().then((n) => n > 0).catch(() => false)) {
      const h = await r.elementHandle().catch(() => null);
      if (h && await h.isVisible().catch(() => false)) return h;
    }
    const c = cssFallback.first();
    if (await c.count().then((n) => n > 0).catch(() => false)) {
      const h = await c.elementHandle().catch(() => null);
      if (h && await h.isVisible().catch(() => false)) return h;
    }
    await scrollTopCardIntoView(page);
    await humanDelay(800, 1400);
  }
  return null;
}

/**
 * When the apply button can't be found, log what the page really is. Terminal-only, one block,
 * so a stuck run produces a diagnosis instead of an unexplained "Manual needed" x20. This is
 * how we stop guessing selectors: the next real run tells us the actual DOM state.
 */
async function describeApplyArea(page) {
  const info = await page.evaluate(() => {
    const url = location.href;
    const authwall = /\/login|\/authwall|\/signup|\/uas\/login/i.test(url);
    // Every button that plausibly relates to applying, with the signals that matter.
    const btns = [...document.querySelectorAll('button, a[role="button"]')]
      .map((b) => ({
        text: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        aria: (b.getAttribute('aria-label') || '').slice(0, 50),
        disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true',
      }))
      .filter((b) => /apply|submit/i.test(b.text + ' ' + b.aria))
      .slice(0, 8);
    const modalOpen = !!document.querySelector('.jobs-easy-apply-modal, [data-test-modal][role="dialog"]');
    const paneText = (document.querySelector('.job-details-jobs-unified-top-card, .jobs-unified-top-card')?.innerText || '')
      .replace(/\s+/g, ' ').trim().slice(0, 120);
    return { url, authwall, btns, modalOpen, paneText };
  }).catch(() => null);

  if (!info) { console.log('     [diag] could not read the page'); return; }
  console.log('     [diag] URL:', info.url);
  if (info.authwall) console.log('     [diag] ⚠ this is a LOGIN/AUTHWALL page — the session is not active here; log in again');
  if (info.modalOpen) console.log('     [diag] an Easy-Apply modal IS open — the button was likely already clicked');
  if (info.btns.length) {
    console.log('     [diag] apply-related controls actually on the page:');
    for (const b of info.btns) console.log(`        · "${b.text}"  aria="${b.aria}"${b.disabled ? '  (disabled)' : ''}`);
  } else {
    console.log('     [diag] NO button on the page contains "apply" or "submit" — the pane is empty or still loading');
  }
  if (info.paneText) console.log('     [diag] top-card text:', info.paneText);
}

async function dismissPostSubmit(page) {
  // "Application sent" confirmation → close it.
  const done = await page.$('button[aria-label="Dismiss"], button[aria-label="Done"]');
  if (done) await done.click({ timeout: 3000 }).catch(() => {});
}

/** Nudge the job detail pane so its top card (where Easy Apply lives) is on screen. */
async function scrollTopCardIntoView(page) {
  await page.evaluate(() => {
    const el = document.querySelector('.job-details-jobs-unified-top-card, .jobs-unified-top-card, .jobs-details');
    if (el) el.scrollIntoView({ block: 'center' });
  }).catch(() => {});
}

async function closeModal(page) {
  const x = await page.$('button[aria-label="Dismiss"]');
  if (x) {
    await x.click({ timeout: 3000 }).catch(() => {});
    await humanDelay(400, 900);
    // "Discard" the draft if asked
    const discard = await page.$('button[data-control-name="discard_application_confirm_btn"], button:has-text("Discard")');
    if (discard) await discard.click({ timeout: 3000 }).catch(() => {});
  }
}
