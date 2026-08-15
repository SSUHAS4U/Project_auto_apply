// LinkedIn adapter. Drives LinkedIn's native **Easy Apply** on the owner's logged-in
// session. Searches with the Easy-Apply filter (f_AL=true) so we only open jobs we can
// actually one-click apply to, walks the multi-step Easy Apply modal, answers screening
// questions from the profile/AI, and (optionally) sends a connection request afterward.
// Conservative by design — human delays, caps, stop-on-pause; never touches external
// "Apply on company website" links.
import fs from 'node:fs';
import { fault } from '../fault.js';
import path from 'node:path';
import { humanDelay, sleep, botChallengeCount, APP_DIR, browserMemoryMB,
  BROWSER_MEMORY_LIMIT_MB, RECYCLE_SIGNAL } from '../browser.js';
import { logEvent } from '../logfile.js';
import { fillForm, fillChoices, fillDropdowns, observeResume } from '../fill.js';
import { logSearch, logJobHeader, logSkipped, logResult, logSummary, beginJob, setLedger } from '../log.js';
import { newLedger, seal } from '../ledger.js';
import { sendConnectionRequests, checkAcceptances, sendApprovedMessages, sendFollowUps } from './outreach.js';
import { shouldApply, shouldContact, claimOutreach } from '../gate.js';
import { cleanupDue, withdrawStaleInvites } from '../invites.js';

/**
 * Gap between one search and the next.
 *
 * The previous run did 216 result loads in 90 minutes — one every 25 seconds — and LinkedIn
 * flagged it `uc=scraping` eight seconds in. Two minutes between searches is a rate a person
 * plausibly produces, and over a 90-minute phase it still covers ~45 pairs: seven times the
 * work of the six-search cap, at a twentieth of the old request rate.
 */
const SEARCH_GAP_MS = 120_000;
// Seniority is filtered here because LinkedIn's own filters don't reliably exclude it. The
// COMPATIBILITY decision does not live in this file — `gate.js → shouldApply` owns it, so
// LinkedIn and Indeed cannot drift apart. (This used to carry a FIT_THRESHOLD of 25 on keyword
// overlap; that is what let a Python role through to a Java résumé.)
const SENIOR_RE = /\b(senior|sr\.?|lead|principal|staff|architect|manager|director|head\s+of|vp|vice\s*president)\b/i;

// LinkedIn pages at 25 results and offsets with `start`. Reading only page 1 capped every
// search at 25 regardless of how many matches existed.

/**
 * The search URL, in either of the two forms LinkedIn serves.
 *
 * Which one works is NOT stable, so this builds both and the caller checks which survived.
 * The evidence for that, from two consecutive days of the run log:
 *
 *   2026-08-13  /jobs/search/  redirected 234 times to /jobs/search-results?skipRedirect=true,
 *               and the redirect dropped `location`. v154 moved to /jobs/search-results/ for
 *               exactly this reason.
 *   2026-08-14  /jobs/search-results/ was itself rewritten by LinkedIn's own SPA — 73 of 92
 *               landings had `location` and `sortBy` stripped — while every /jobs/search/
 *               navigation kept them. Zero redirects that day.
 *
 * Same code, opposite outcome, one day apart. So "pick the right URL" is not a decision that
 * can be made once in the source; it has to be made per run, from what the page actually does.
 * Hard-coding either form guarantees a nationwide search on the day LinkedIn flips back — which
 * is what a whole run of 72 searches finding 4 distinct jobs looked like.
 */
function searchUrl(keyword, location, start = 0, maxAgeDays = 0, form = 'search-results') {
  const p = new URLSearchParams({ keywords: keyword, f_AL: 'true', sortBy: 'DD' }); // f_AL = Easy Apply only
  if (location && location.toLowerCase() !== 'remote') p.set('location', location);
  else p.set('f_WT', '2'); // remote
  if (start > 0) p.set('start', String(start));
  // f_TPR=r<seconds> — "posted within". Keeps months-old, almost certainly filled postings out.
  if (maxAgeDays > 0) p.set('f_TPR', `r${Math.round(maxAgeDays * 86400)}`);
  return `https://www.linkedin.com/jobs/${form}/?${p.toString()}`;
}

/**
 * Did the location filter SURVIVE the landing?
 *
 * This is the check whose absence cost a whole run. Every search asked for a city, LinkedIn
 * dropped it, and the worker searched the entire country 72 times without noticing — the URL it
 * asked for and the URL it got were never compared. Eleven searches across four keywords and
 * six cities returned four distinct job ids in total, each found ten or eleven times over.
 *
 * Exported so it can be tested against real captured URLs rather than asserted about.
 */
export function locationKept(landedUrl, location) {
  const url = String(landedUrl || '');
  // Remote is expressed as a work-type flag, not a place.
  if (!location || location.toLowerCase() === 'remote') return /[?&]f_WT=2\b/.test(url);
  // Compare loosely: LinkedIn re-encodes ("Bengaluru" may come back percent-encoded, or as
  // "Bengaluru, Karnataka, India"), and a strict equality check would report a working filter
  // as broken — the same false alarm in the opposite direction.
  const want = location.toLowerCase().replace(/[^a-z]/g, '');
  // decodeURIComponent THROWS on a lone '%' — and a URL from a live redirect is not guaranteed
  // to be well-formed. This runs on every single search, so an exception here would take down
  // the phase it exists to protect. Fall back to the raw string: a percent-encoded city still
  // matches once the non-letters are stripped, so the check degrades rather than fails.
  let got;
  try { got = decodeURIComponent(url); } catch { got = url; }
  got = got.toLowerCase().replace(/[^a-z]/g, '');
  return want.length > 2 && got.includes(want);
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

/**
 * The same list, plus anything that merely CONTAINS a job link.
 *
 * Every selector above is a LinkedIn class or data attribute, and LinkedIn renames them. When
 * it moved to /jobs/search-results/ the whole set matched nothing, so 110 searches reported
 * "0 Easy-Apply jobs" against pages that were full of jobs — the same failure the post collector
 * had when its classes were hashed, and it was solved there the same way.
 *
 * A job card IS an element containing a link to /jobs/view/<id>. That is what the thing is,
 * not what it is currently called, so no rename can break it. The id comes out of the href.
 */
const CARD_SELECTOR_ANY = `${CARD_SELECTOR}, a[href*="/jobs/view/"]`;

/**
 * Wait for the results LIST, and make it render.
 *
 * The old version waited for the first match of CARD_SELECTOR_ANY and stopped. That selector
 * also matches the detail pane's own job link, and LinkedIn auto-selects a job on landing — so
 * it was satisfied by the ONE job in the pane, roughly three seconds after navigation, before
 * the list had rendered anything. Every search then reported "1 Easy-Apply job". Waiting for
 * "a job link" is not the same as waiting for "the list of jobs", and the difference was 1
 * result instead of 25.
 *
 * LinkedIn virtualises the list: rows materialise as they scroll into view. So this scrolls the
 * results rail to force them in, and settles when the count stops growing rather than after a
 * fixed sleep — a fixed sleep is either too short on a slow load or wasted time on a fast one.
 */
async function waitForResults(page) {
  await page.waitForSelector(CARD_SELECTOR_ANY, { timeout: 18000 }).catch(() => {});
  let last = -1;
  for (let i = 0; i < 8; i++) {
    const n = await page.evaluate((sel) => {
      // Scroll the rail that actually holds the results, not the window — the list is its own
      // scroll container and scrolling the page moves nothing.
      const rail = document.querySelector(
        '.jobs-search-results-list, .scaffold-layout__list, [class*="jobs-search-results"]');
      if (rail) rail.scrollBy(0, rail.clientHeight || 600);
      else window.scrollBy(0, 600);
      return document.querySelectorAll(sel).length;
    }, CARD_SELECTOR_ANY).catch(() => 0);
    if (n > 0 && n === last) break;     // settled — the list stopped growing
    last = n;
    await page.waitForTimeout(700).catch(() => {});
  }
  // Back to the top so the first card is the first result, not wherever the scroll ended.
  await page.evaluate(() => {
    const rail = document.querySelector(
      '.jobs-search-results-list, .scaffold-layout__list, [class*="jobs-search-results"]');
    if (rail) rail.scrollTo(0, 0); else window.scrollTo(0, 0);
  }).catch(() => {});
}

async function collectJobCards(page) {
  // The results rail; ids live on the <li> or a data attribute. Also grab the title + company
  // from the CARD itself — the detail pane sometimes hasn't rendered when we read it, and we
  // never want to log a job with no role. LinkedIn changes these classes often, so cast wide.
  const cards = await page.$$eval(CARD_SELECTOR_ANY, (nodes) => {
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
      // The id, from a data attribute if LinkedIn still sets one — otherwise straight out of
      // the job link's href. /jobs/view/<id> is the one part of a job card that cannot be
      // renamed, because it is the address of the job itself.
      const hrefOf = (el) => (el && el.getAttribute && el.getAttribute('href')) || '';
      const fromHref = (h) => { const m = String(h).match(/\/jobs\/view\/(\d+)/); return m ? m[1] : null; };
      const id = n.getAttribute('data-occludable-job-id') || n.getAttribute('data-job-id')
        || (n.querySelector('[data-job-id]') && n.querySelector('[data-job-id]').getAttribute('data-job-id'))
        || fromHref(hrefOf(n))
        || fromHref(hrefOf(n.querySelector && n.querySelector('a[href*="/jobs/view/"]')));
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
  // EXPAND THE DESCRIPTION FIRST. LinkedIn collapses it behind a "see more" control and only
  // renders a preview until that is clicked.
  //
  // Measured over 278 reads in one run: median 600 characters, against real postings of several
  // thousand. So the fit gate was judging roughly the first paragraph of every job — the part
  // that says who the company is, not what the role needs. Requirements live below the fold,
  // which is precisely the text a skills match depends on.
  //
  // Clicked page-side by geometry rather than by class name: LinkedIn ships hashed class names
  // that change on deploy, and the control has appeared as both a button and a link. Matching
  // the visible label is what survives. Failure here is not fatal — a truncated description
  // still beats none, so this only ever improves what the next step reads.
  // Click, then CHECK IT WORKED — and try the next candidate if it did not.
  //
  // The old version clicked the first control whose label looked right and moved on, assuming
  // success. "More" is a common label on a LinkedIn job pane (the overflow menu, "Show more
  // results", the company follow card), so the first match was often not the description's
  // expander at all — and having clicked something, it stopped and never tried the real one.
  // Measuring the description length before and after turns that guess into a fact.
  const paneChars = () => page.evaluate(() => {
    const d = document.querySelector('#job-details, [class*="jobs-description"]');
    return ((d && d.innerText) || '').replace(/\s+/g, ' ').trim().length;
  }).catch(() => 0);
  let beforeChars = await paneChars();
  for (let attempt = 0; attempt < 4; attempt++) {
    const clicked = await page.evaluate((skip) => {
      const wanted = /see more|show more|…more|more/i;
      let seen = 0;
      for (const n of document.querySelectorAll('button, [role="button"], a')) {
        const label = ((n.getAttribute('aria-label') || '') + ' ' + (n.innerText || ''))
          .replace(/\s+/g, ' ').trim();
        if (!label || label.length > 40 || !wanted.test(label)) continue;
        const r = n.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (seen++ < skip) continue;      // already tried this one
        n.click();
        return true;
      }
      return false;
    }, attempt).catch(() => false);
    if (!clicked) break;                  // no more candidates
    await humanDelay(400, 900);
    const afterChars = await paneChars();
    if (afterChars > beforeChars) break;  // it expanded — done
    beforeChars = afterChars;
  }

  // The description is what the compatibility gate judges on, so an empty one means the job is
  // skipped as "no description to judge" — which is exactly what happened to a whole run when
  // these class names went stale. Try the known containers, then fall back to the LARGEST text
  // block in the details pane, which survives any rename.
  const named = await text('#job-details, .jobs-description__content, .jobs-box__html-content, '
    + '[class*="jobs-description"], .jobs-details__main-content [class*="description"]');
  // BOTH reads, then the longer — not "fall back only if the first is tiny".
  //
  // The old rule ran the fallback only when the named containers returned under 80 characters.
  // A run then read descriptions of 95, 98, 111 and 115 characters: over the threshold, so the
  // fallback never ran, and a one-line fragment was handed to the fit gate as though it were the
  // job. Every job it judged came back with the identical score of 57, "partial overlap", which
  // is what a matcher says when it is shown almost no text. 80 was never a description; it was
  // just above the number that would have triggered a second look.
  //
  // Real postings run to thousands of characters, so the longer of the two reads is the better
  // one essentially always, and comparing costs one page evaluation.
  let description = named;
  {
    const alternative = await page.evaluate(() => {
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
      // 120, not 200. The floor exists to reject stray UI text, but a genuine short posting
      // ("We need a Java backend engineer in Pune. 3+ years. Apply within.") sits between the
      // two — and discarding it handed the win to whatever the named selector had grabbed,
      // which was sometimes the top card's metadata line. Below 120 it is not prose; above it,
      // let the gate judge, and DESCRIPTION_TOO_SHORT still flags anything under 300.
      return best.replace(/\s+/g, ' ').trim().length >= 120 ? best : '';
    }).catch(() => '');
    const len = (t) => (t || '').replace(/\s+/g, ' ').trim().length;
    if (len(alternative) > len(description)) description = alternative;
  }

  // Record WHAT WAS READ, not only how much of it.
  //
  // The previous log said `descriptionChars: 111` and nothing else, so a short read could be
  // seen but not diagnosed — there was no way to tell a truncated description from the wrong
  // element entirely without another run. A sample costs one log line and answers it outright.
  const flat = description.replace(/\s+/g, ' ').trim();
  logEvent('posting', {
    chars: flat.length,
    fromNamedContainer: named.replace(/\s+/g, ' ').trim().length,
    sample: flat.slice(0, 220),
  });
  // A job description this short is not a short job description — it is a failed read. Say so,
  // rather than letting the fit gate deliver a confident verdict on one line of text.
  if (flat.length > 0 && flat.length < 300) {
    fault('DESCRIPTION_TOO_SHORT', { chars: flat.length, sample: flat.slice(0, 160), url: page.url() });
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
  // Say it in the TERMINAL as well. This only ever emitted a dashboard event, so the terminal
  // showed "▶ LINKEDIN — starting" followed immediately by a 0/0/0 summary with no reason at
  // all — indistinguishable from the automation being broken, which is exactly how it read.
  console.log('\n  ⚠ Not signed in to LinkedIn — the li_at session cookie is gone.');
  console.log('     The signed-out job search still lists jobs, but those pages carry no Easy');
  console.log('     Apply button, so there is nothing to apply to. Sign in once in the window');
  console.log('     that opens; the session is remembered from then on.\n');
  // Tell the backend NOW, so the Connections card stops claiming Active the instant we know
  // otherwise. Waiting for the periodic sweep left a green "Active" badge next to a run that
  // had just ended 0/0/0 because the cookie was gone — the dashboard contradicting the log.
  await api.session('linkedin', false, 'Signed out — the LinkedIn session cookie is gone.')
    .catch(() => { /* the event below still records it */ });
  await api.event({
    runId: state.runId, portal: 'linkedin', type: 'error',
    detail: 'Not signed in to LinkedIn. The signed-out job search still lists jobs, but those pages '
      + 'have no Easy Apply button — nothing can be applied to. JobPilot will open a login window on '
      + 'the next run; sign in there once and the session is remembered.',
  });
  return false;
}

/**
 * Is the page still usable? A closed page rejects every call instantly, which is exactly what a
 * dead browser looks like from inside the job loop: fifty failures in two milliseconds.
 */
async function pageAlive(page) {
  try {
    if (!page || page.isClosed?.()) return false;
    await page.evaluate(() => 1);
    return true;
  } catch { return false; }
}

export async function runLinkedIn(page, api, plan, state, ctx) {
  // Account for every job this block touches. Sealed before the return below, whatever the
  // ending — finished, stopped, timed out — so a run can never end unexplained.
  const runLedger = newLedger('linkedin');
  setLedger(runLedger);
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
  // The block clock starts ONCE, not on every attempt.
  //
  // index.js relaunches the browser and calls this adapter again when the browser dies mid-run.
  // Both deadlines used to be `Date.now() + budget`, so a retry handed Phase 1 a brand-new
  // 90 minutes and the block a brand-new 210 — the run of 2026-08-14 restarted Easy Apply from
  // pair #44 with a full budget after the browser died at minute 56. Outreach, post scan and
  // recruiter email were never reached, in that run or any other: Phase 1 could always afford
  // to consume everything, twice.
  if (!state.blockStartedAt) state.blockStartedAt = Date.now();
  const deadline = state.blockStartedAt + blockMin * 60_000;
  let applied = 0;
  const tally = { manual: 0, attention: 0, failed: 0, skipped: 0 };

  const mode = plan.mode || 'all';
  // Per-run apply cap comes from the gear setting (default 15). Phase 1 also gets AT MOST one
  // hour: if it can't hit the cap in that time it stops applying and moves to outreach.
  // applyCap is what's LEFT of today's quota (the backend subtracts what already went out),
  // so an unfinished quota automatically rolls into the next run.
  const applyCap = plan.applyCap ?? 15;
  const maxAgeDays = plan.maxAgeDays || 0;   // skip postings older than this
  // PerimeterX challenges already counted when the previous search started, so the pacing below
  // can react to NEW ones rather than to the running total.
  let lastChallengeCount = botChallengeCount();
  // What the PREVIOUS search returned. The backoff needs evidence of harm, and an
  // empty result set is that evidence; a rising challenge counter on its own is not.
  let lastSearchCards = -1;
  let paneFailures = 0;                      // consecutive job pages that would not render
  let paneRests = 0;                         // how many times we have backed off for them
  // ONE result page per search, whatever the plan asks for.
  //
  // Three pages meant three result loads per keyword/location pair before a single job was
  // opened — 216 loads across the matrix, one every 25 seconds for 90 minutes. Pages 2 and 3 of
  // a LinkedIn search are largely the same postings repeated by different agencies, so the run
  // was spending most of its detection budget on its worst results. Clamped here rather than in
  // the plan so a stale setting on the backend cannot quietly reintroduce it.
  const pagesPerSearch = 1;
  void plan.pagesPerSearch;
  const dailyTarget = plan.dailyTarget || applyCap;
  const doneToday = plan.appliedToday || 0;
  // Phase 1's budget is SPENT, not restarted. `state.phase1SpentMs` survives a relaunch because
  // index.js reuses the same state object across the retry, so a crash 56 minutes in leaves 34
  // minutes of Easy Apply and then the remaining flows run — instead of Easy Apply starting over
  // and eating the block a second time.
  const phase1BudgetMs = Math.max(plan.phase1Minutes || 90, 5) * 60_000;
  const phase1Spent = state.phase1SpentMs || 0;
  const phase1StartedAt = Date.now();
  const phase1Deadline = Math.min(phase1StartedAt + Math.max(phase1BudgetMs - phase1Spent, 0), deadline);
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
  // Already spent its budget on an earlier attempt of this block? Then it is finished, and the
  // remaining flows get the rest. Without this the retry after a browser crash simply restarted
  // Easy Apply — which is why post scan, recruiter email and connections have never once run.
  const phase1Exhausted = phase1Spent >= phase1BudgetMs;
  if (phase1Exhausted) {
    console.log(`\n  ⏭  Easy Apply — its ${Math.round(phase1BudgetMs / 60_000)}m were already used `
      + 'before the browser restarted; going straight to the outreach flows.');
  }
  if (!easyApplyOff && !phase1Exhausted && mode !== 'outreach' && applyCap > 0) {
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
    // ROTATE the search matrix instead of walking all of it every run.
    //
    // The owner's plan is 12 keywords x 6 locations x 3 pages = 216 result-page loads inside a
    // 90-minute phase: one every 25 seconds, before a single job is opened. LinkedIn's
    // PerimeterX reads exactly that and flags the session `uc=scraping` from the first page —
    // after which job pages return no data at all, which is why 72 searches reported 0 jobs and
    // the run applied to nothing.
    //
    // Cutting the settings would silently discard what the owner configured. Rotating does not:
    // each run takes a WINDOW of the matrix and the next run starts where this one stopped, so
    // every keyword and location is still covered — just across several runs instead of one
    // burst. A day's coverage is unchanged; the request rate is what drops.
    const pairs = [];
    for (const keyword of plan.keywords) {
      for (const location of plan.locations) pairs.push({ keyword, location });
    }
    const offsetFile = path.join(APP_DIR, '.search-offset');
    let offset = 0;
    try { offset = parseInt(fs.readFileSync(offsetFile, 'utf8'), 10) || 0; } catch { /* first run */ }
    // TIME-BOXED, not count-boxed.
    //
    // Cutting the run to six pairs fixed the request RATE and broke the schedule: the phase
    // exhausted its six searches in 11 minutes and then sat idle for the remaining 79 of its
    // 90. That trades detection risk for doing almost nothing, which is not a trade worth
    // making — PerimeterX reads the rate, not the total, so the answer is to keep going at a
    // human pace rather than to stop early.
    //
    // So: work through the whole matrix in order, starting where the last run stopped, until
    // the time budget or the apply cap says otherwise. The offset is written after EVERY pair
    // rather than once up front, so a run that is stopped, crashes, or runs out of time still
    // resumes from the right place instead of repeating what it already searched.
    const slice = [];
    for (let i = 0; i < pairs.length; i++) slice.push(pairs[(offset + i) % pairs.length]);
    console.log(`\n  Searching from pair #${offset + 1} of ${pairs.length}, `
      + `about one every ${Math.round(SEARCH_GAP_MS / 1000)}s until the ${plan.phase1Minutes || 90}m budget is used.`);
    console.log('  (the next run continues from wherever this one stops, so everything is covered.)');
    logEvent('search', { event: 'matrix', total: pairs.length, offset, gapMs: SEARCH_GAP_MS });

    let searchesDone = 0;

    outer:
    for (const { keyword, location } of slice) {
      {
        // Bank the time spent BEFORE doing anything that can crash the browser.
        //
        // Phase 1 exits by throwing when the browser dies, so an accounting line placed after
        // the loop would never run in exactly the case it exists for. Updating it each pair
        // means the retry knows how much of the 90 minutes is genuinely gone, whichever way
        // this phase ends.
        state.phase1SpentMs = phase1Spent + (Date.now() - phase1StartedAt);
        // Space the searches out. This is the whole anti-detection budget now: not fewer
        // searches, just slower ones. Skipped before the first so a short run still starts
        // immediately, and broken into short sleeps so Stop and Pause stay responsive.
        // The adapter harness sets JOBPILOT_TEST_NO_PACING; without honouring it here a suite
        // that walks several searches would sit idle for hours. Nothing in the app sets it.
        if (searchesDone > 0 && process.env.JOBPILOT_TEST_NO_PACING !== '1') {
          // MEASURE the challenges; do NOT brake on them by themselves.
          //
          // The first version of this added a minute per fresh challenge, capped at five. The
          // run that followed shows why that was wrong: PerimeterX fires per REQUEST, not per
          // search, so the counter jumped by 19 and 37 between searches and every gap pinned
          // itself to the 5-minute cap. Searches went from 2 minutes to 7, Easy Apply spent its
          // whole budget waiting, and the outreach flows never ran — the brake caused the exact
          // starvation it was added alongside.
          //
          // And the challenges were not doing any harm: that same run found 7 to 25 jobs per
          // search and submitted three applications. A challenge is LinkedIn's sensor firing,
          // not LinkedIn refusing. So the brake now needs EVIDENCE OF HARM — a search that
          // came back empty while the challenge count was climbing. Challenges alone are
          // recorded and otherwise ignored.
          const seenNow = botChallengeCount();
          const fresh = Math.max(0, seenNow - lastChallengeCount);
          lastChallengeCount = seenNow;
          const harmed = fresh > 0 && lastSearchCards === 0;
          const extraMs = harmed ? 120_000 : 0;
          if (fresh > 0) {
            logEvent('gate', { event: 'challenges', fresh, total: seenNow,
              lastSearchCards, backedOff: harmed });
          }
          if (harmed) {
            console.log(`     · the last search came back empty while LinkedIn challenged `
              + `${fresh} request(s) — waiting an extra 2m before trying again.`);
          }
          const until = Date.now() + SEARCH_GAP_MS + extraMs;
          while (Date.now() < until && !state.stopped && !state.paused
                 && Date.now() < phase1Deadline && applied < applyCap) {
            await sleep(3000);
          }
        }
        searchesDone++;
        // Record progress per pair, not once at the start: a run that is stopped or times out
        // must resume where it actually got to, otherwise the next run repeats the same
        // searches and the far end of the matrix is never reached at all.
        try {
          fs.writeFileSync(offsetFile, String((offset + searchesDone) % pairs.length));
        } catch { /* non-fatal */ }
        if (state.stopped || state.paused || Date.now() > phase1Deadline || applied >= applyCap) {
          phase1End = state.stopped ? 'the run was stopped'
            : state.paused ? 'paused'
            : applied >= applyCap ? `the daily cap of ${applyCap} applications was reached`
            : `the ${plan.phase1Minutes || 90}-minute Easy Apply budget ran out`;
          break outer;
        }

      state.action = `Opening LinkedIn Easy-Apply search: "${keyword}" in ${location}`;
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: state.action });
      // The PRIMARY search, and the one that was still swallowing its failure.
      //
      // The pagination goto below was fixed; this one was missed, and it is the one that runs
      // for every keyword/location pair. So when the browser died mid-run, every remaining
      // search quietly returned zero cards and printed "0 Easy-Apply jobs" — while the poller
      // printed "the automation browser is not responding … the run will relaunch it" every few
      // seconds, promising a recovery that could not happen because nothing ever threw.
      //
      // index.js already knows how to relaunch and retry a block; it just never heard about it.
      // Run the search, then CHECK WHAT WE ACTUALLY GOT — and try the other URL form if the
      // first one was rewritten out from under us.
      //
      // Neither form is reliably correct (see searchUrl). The run of 2026-08-14 asked for six
      // cities and got a nationwide search every time because LinkedIn's SPA stripped
      // `location` after landing, and nothing compared the URL requested with the URL reached.
      // Seventy-two searches produced four distinct jobs. Verification is the fix; picking a
      // different favourite URL would just move the day it breaks.
      let cards = [];
      let landed = '';
      let usedForm = null;
      let filterKept = false;
      for (const form of ['search-results', 'search']) {
        const ok = await page.goto(searchUrl(keyword, location, 0, maxAgeDays, form),
          { waitUntil: 'domcontentloaded' })
          .then(() => true)
          .catch((e) => {
            logEvent('search', { outcome: 'goto-failed', keyword, location, page: 0, form,
              error: String(e && e.message).slice(0, 200) });
            return false;
          });
        // A search that cannot navigate is not a search with no results. After the browser died
        // mid-run, 70 consecutive searches printed "0 Easy-Apply jobs" and the run announced
        // "every search was exhausted" without having navigated once.
        if (!ok && !(await pageAlive(page))) {
          throw new Error('Target page, context or browser has been closed');
        }
        await waitForResults(page);

        landed = page.url();
        filterKept = locationKept(landed, location);
        cards = await collectJobCards(page);
        // The auto-selected job in the detail pane is NOT a search result. LinkedIn opens one on
        // landing, its link matches the card selector, and for a whole run that single job was
        // the entire "result set" — the same job id found eleven times across eleven different
        // searches. If the list gave us nothing but the job already open, the list did not load.
        const paneId = (landed.match(/currentJobId=(\d+)/) || [])[1] || null;
        const onlyThePane = cards.length === 1 && paneId && cards[0].id === paneId;

        logEvent('search', { outcome: 'attempt', keyword, location, form, landed,
          filterKept, cards: cards.length, onlyThePane });

        usedForm = form;
        if (filterKept && !onlyThePane) break;   // this form worked; stop trying
        if (form === 'search') {
          // Both forms failed the same check. Say which one, and what it means, rather than
          // reporting a small number of results as though the search had simply gone quiet.
          if (!filterKept) fault('SEARCH_FILTER_DROPPED', { keyword, location, landed });
          else if (onlyThePane) fault('SEARCH_LIST_NOT_READ', { keyword, location, landed, paneId });
        }
      }
      // Walk further result pages. collectJobCards already collapses reposts, so the stop
      // condition is "this page added nothing new", the same rule Indeed uses.
      const seenIds = new Set(cards.map((c) => c.id));
      for (let pg = 1; pg < pagesPerSearch; pg++) {
        if (state.stopped || state.paused || Date.now() > phase1Deadline) break;
        // Same rule as the job pages: a search that cannot navigate is not a search with no
        // results. The log is unambiguous — after the browser died at 12:03:44 the run printed
        // "0 Easy-Apply jobs" for SEVENTY consecutive searches, then announced "every search was
        // exhausted" and finished, having never navigated again. Not one authwall redirect in the
        // whole run: the session was fine, the browser was gone. Fail loudly so the dead-browser
        // handler in index.js relaunches and retries the block.
        // Same form that worked for page 1 — switching mid-search would re-introduce the very
        // rewrite the loop above just worked around.
        const searchOk = await page.goto(searchUrl(keyword, location, pg * 25, maxAgeDays, usedForm),
          { waitUntil: 'domcontentloaded' })
          .then(() => true)
          .catch((e) => {
            logEvent('search', { outcome: 'goto-failed', keyword, location, page: pg,
              error: String(e && e.message).slice(0, 200) });
            return false;
          });
        if (!searchOk && !(await pageAlive(page))) {
          throw new Error('Target page, context or browser has been closed');
        }
        await waitForResults(page);
        const more = (await collectJobCards(page)).filter((c) => !seenIds.has(c.id));
        if (more.length === 0) break;
        for (const c of more) { seenIds.add(c.id); cards.push(c); }
      }
      const needsLogin = /\/login|\/authwall|signup/i.test(landed);
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
        detail: cards.length > 0
          ? `Found ${cards.length} Easy-Apply jobs for "${keyword}" @ ${location}`
          : needsLogin
            ? `LinkedIn asked to log in — sign into linkedin.com in the browser, then run again`
            : `No Easy-Apply results on this search — LinkedIn may have changed the page or need login` });
      lastSearchCards = cards.length;
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
          // The navigation failure is RECORDED, not swallowed. `.catch(() => {})` here hid the
          // single most important fact in the whole run: the log showed 50 "pane not rendered"
          // entries at four per millisecond, six minutes after the last actual navigation —
          // the page was dead and every goto was rejecting instantly, silently, forever.
          const navOk = await page.goto(jobPaneUrl(keyword, location, id, maxAgeDays),
            { waitUntil: 'domcontentloaded' })
            .then(() => true)
            .catch((e) => {
              logEvent('job', { outcome: 'goto-failed', id, error: String(e && e.message).slice(0, 200) });
              return false;
            });
          // A page that cannot navigate cannot be recovered by trying the next job on it. Spinning
          // through the remaining ids takes milliseconds and produces nothing but a failure streak,
          // and then the rest timer sleeps on a browser that will never answer. Throw so index.js's
          // dead-browser handler relaunches and retries the block — that path already exists and was
          // simply never reached, because this catch ate the very evidence it keys on.
          if (!navOk && !(await pageAlive(page))) {
            throw new Error('Target page, context or browser has been closed');
          }
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
                fault('PANE_WRONG_JOB', { id, url: page.url() });
              }
            }
          }
          if (!pane) {
            paneFailures++;
            // The evidence, every single time — not just the first. Which URL the browser is
            // really on distinguishes an authwall from a 999 rate-limit from a layout change,
            // and those need completely different fixes. The terminal prints one dump per
            // streak to stay readable; the file records all of them.
            logEvent('job', {
              outcome: 'pane-not-rendered', id, streak: paneFailures,
              url: page.url(), title: cardInfo.title || null,
            });
            // Diagnose once with evidence, instead of repeating the same guess 57 times.
            if (paneFailures === 1) {
              fault('PANE_NOT_RENDERING', { id, url: page.url(), streak: paneFailures });
              console.log('     dumping what is actually on the page:');
              await describeJobPage(page).catch(() => {});
              await api.event({ runId: state.runId, portal: 'linkedin', type: 'error',
                url: `https://www.linkedin.com/jobs/view/${id}/`,
                detail: 'job pages are not rendering — LinkedIn layout change or a signed-out session. See the terminal for the page dump.' });
            }
            // REST, then keep going — do not throw away 80 minutes of budget on a streak.
            //
            // A signed-in run found 75 Easy-Apply jobs and still hit this after 9 of its 90
            // minutes. With a valid session and unchanged markup, a streak of blank panes is
            // LinkedIn slowing us down, and the answer to being throttled is to wait, exactly
            // as the Indeed adapter already does (MAX_BACKOFFS there). Ending the phase treats
            // a temporary condition as a permanent fault and guarantees the run does nothing.
            //
            // Three rests of 1, 2 and 3 minutes. Only if the pages are STILL blank after six
            // minutes of patience is this a real fault worth stopping for.
            if (paneFailures > 0 && paneFailures % 15 === 0) {
              paneRests++;
              if (paneRests > 3) {
                console.log(`\n  ✋ job pages still would not load after ${paneRests - 1} rests — ending Phase 1.`);
                console.log('     Usually: the LinkedIn session expired, or LinkedIn changed the job page.');
                await api.event({ runId: state.runId, portal: 'linkedin', type: 'error',
                  detail: `job pages kept failing to load through ${paneRests - 1} backoffs — stopping Easy Apply. `
                    + 'Check you are signed into linkedin.com in the automation browser.' });
                phase1End = 'job pages would not load even after resting';
                break outer;
              }
              // Name the real cause when the evidence is there. LinkedIn's anti-bot fires
              // li.protechts.net?...&uc=scraping alongside a reCAPTCHA Enterprise frame, and
              // from then on the job-cards API 503s, results come back empty and the session
              // stops being honoured. Resting through THAT is pointless — it is not throttling
              // that a minute cures, it is the account being flagged. Say so instead of
              // printing "0 Easy-Apply jobs" seventy times and calling it "searches exhausted".
              const challenges = botChallengeCount();
              if (challenges > 0) {
                console.log(`
  ✋ LinkedIn's bot detection has fired ${challenges} time(s) this run`);
                console.log('     (li.protechts.net / PerimeterX with uc=scraping, plus reCAPTCHA Enterprise).');
                console.log('     Once flagged, job pages return no data however long we wait — this is not');
                console.log('     a slow page. Stopping so the account is not pushed further.');
                await api.event({ runId: state.runId, portal: 'linkedin', type: 'error',
                  detail: `LinkedIn flagged this session as automated (${challenges} bot-detection `
                    + 'challenges). Job pages stopped returning data. Reduce the number of searches '
                    + 'per run, or leave LinkedIn alone for a few hours before trying again.' });
                await api.runStatus(state.runId, 'needs_attention',
                  'LinkedIn flagged the session as automated').catch(() => {});
                phase1End = 'LinkedIn flagged the session as automated';
                break outer;
              }
              const restMs = paneRests * 60_000;
              console.log(`\n  ⏸ ${paneFailures} job pages in a row would not load — resting ${paneRests}m, then continuing.`);
              console.log('     (LinkedIn throttles fast browsing; the run has budget left, so wait rather than quit.)');
              state.action = `Resting ${paneRests}m — LinkedIn is not rendering job pages`;
              await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
                detail: `${paneFailures} job pages would not render — resting ${paneRests}m before continuing.` });
              // Broken into short sleeps so Stop and Pause still take effect promptly, and so
              // the run keeps writing events (the backend reads those as proof it is alive).
              for (let i = 0; i < restMs / 5000 && !state.stopped && Date.now() < deadline; i++) {
                await sleep(5000);
              }
              if (state.stopped || Date.now() >= deadline) { phase1End = 'time or stop'; break outer; }
            }
            continue;
          }
          paneFailures = 0;   // a page loaded — the streak is broken
          await humanDelay(1200, 2400);

          const post = await readPosting(page);
          logEvent('job', {
            outcome: 'page-read', id, url: page.url(),
            title: post.title || null, titleFrom: post.title ? 'pane' : 'card',
            descriptionChars: (post.description || '').length,
            company: post.company || null, easyApply: post.easyApply ?? null,
          });
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
          await recycleIfBloated(state);
          const result = await easyApply(page, api, profile, state);
          if (result === 'applied') {
            applied++;
            logResult('applied');
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'easy_apply',
              title, company, url: `https://www.linkedin.com/jobs/view/${id}/`,
              // The resume LinkedIn actually attached, recorded per application — that is the
              // whole point of observing it instead of uploading one.
              detail: `fit ${score}${state.resumeName ? ` — resume: ${state.resumeName}` : ''}` });
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
            // ALWAYS carry a reason. `blockedQuestions` is empty whenever the pause came from
            // something that is not a question — the resume guard, most of all — and passing
            // undefined made the ledger record "attention: attention" for 30 jobs. Thirty
            // pauses with nothing to explain them is precisely the blindness the ledger exists
            // to remove, so an unattributed pause is now labelled as one.
            const blocked = (state.blockedQuestions || [])[0]
              || state.attentionReason || 'paused with no reason recorded (instrumentation gap)';
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
          // A recycle request and a dead browser are not failed jobs — both must reach index.js,
          // which relaunches and continues the block. Counted as a failed job here, the recycle
          // never happens and the browser keeps growing to the point it exists to prevent.
          const msg = String((e && e.message) || e);
          if (msg === RECYCLE_SIGNAL || /target page, context or browser has been closed/i.test(msg)) throw e;
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
    state.phase1SpentMs = phase1Spent + (Date.now() - phase1StartedAt);
    // Total across every attempt of this block, not just this one — after a relaunch, "3m" for
    // a phase that had already run 56 minutes is a lie the log used to tell.
    const usedMin = Math.round(state.phase1SpentMs / 60000);
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
        // Same rule one level up: a flow that ends because the browser needs recycling must
        // not be reported as "the flow ended early" and quietly skipped — the block would then
        // walk through post scan, email and connections in seconds, each swallowing the same
        // signal, and finish having done none of them.
        const msg = String((e && e.message) || e);
        if (msg === RECYCLE_SIGNAL || /target page, context or browser has been closed/i.test(msg)) {
          api.flow = null;
          throw e;
        }
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
  seal(runLedger, { applied, searched: runLedger.seen });
  setLedger(null);
  return { applied, ...tally };
}

// ---- Phase 1: hiring-post scan → HR email extraction ------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_JUNK = /no-?reply|example\.|linkedin\.com|\.png$|\.jpe?g$|\.gif$|support@|help@|info@linkedin/i;

/**
 * Look for the author's email where a person would actually look: their profile.
 *
 * The scan only ever read the POST text, and recruiters almost never put an address there —
 * 117 posts in one run were counted as having no address, and 0 emails were sent all day. A
 * human looking for a recruiter's email opens their profile and checks the contact panel and
 * the About section, which is where people do put it.
 *
 * Opens the profile in a SEPARATE tab so the feed the scan is walking keeps its scroll
 * position; a scan that restarts from the top on every author re-reads the same posts forever.
 * Every step is best-effort: an email is a bonus route, and failing to find one must never cost
 * the message or connection route that would otherwise have run.
 *
 * @returns {Promise<string>} the address, or '' when there is none to find.
 */
async function emailFromProfile(ctx, authorUrl) {
  if (!ctx || !authorUrl) return '';
  let p = null;
  try {
    p = await ctx.newPage();
    await p.goto(authorUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await humanDelay(900, 1800);

    // 1. The contact panel — where LinkedIn puts an address the person chose to publish.
    //    Reached by its own URL rather than by clicking "Contact info", because the link's
    //    label and class both change and the overlay URL has been stable for years.
    const contactUrl = authorUrl.replace(/\/+$/, '') + '/overlay/contact-info/';
    await p.goto(contactUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await humanDelay(700, 1400);
    let text = await p.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    let hit = (text.match(EMAIL_RE) || []).filter((e) => !EMAIL_JUNK.test(e))[0];
    if (hit) return hit;

    // 2. The profile body — About sections and headlines often carry "reach me at …".
    await p.goto(authorUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await humanDelay(700, 1400);
    text = await p.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    hit = (text.match(EMAIL_RE) || []).filter((e) => !EMAIL_JUNK.test(e))[0];
    return hit || '';
  } catch {
    return '';
  } finally {
    if (p) await p.close().catch(() => {});
  }
}
// Obvious non-recruiter addresses — never lead on these.

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
  // 60 scrolls, not 25.
  //
  // With re-reads no longer inflating the count, a pass over one search yields far fewer NEW
  // posts than the old number suggested — the "159 analysed in 2 minutes" was the same handful
  // of posts counted over and over. Reaching a genuine 150 means going deeper into each feed
  // and through more searches, so the scroll depth and the pass count both go up. Every loop
  // here is still bounded by the time budget, the post target and the contact cap, so this
  // raises the ceiling without being able to overrun anything.
  const scrolls = dedicated ? 60 : 4;
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
  const routed = { email: 0, message: 0, manual: 0, notHiring: 0, noAddress: 0, skipped: 0,
                   duplicate: 0, alreadyContacted: 0 };
  // Every DISTINCT post seen this block, so re-reads after a scroll are not counted again.
  const postKeys = new Set();
  console.log(`\n  🔎 Scanning hiring posts — target ${target} post(s) this block…`);

  // SEARCH UNTIL THE BUDGET IS USED, not until the keyword list runs out.
  //
  // This walked the keywords once and stopped, so a 60-minute post scan finished in two
  // minutes and handed back 58 — and a 30-minute email scan finished in one. Reporting that as
  // "it ran out of posts" was wrong: LinkedIn has effectively unlimited posts, and the flow had
  // simply stopped asking. It is the same defect Easy Apply had, fixed there and not carried
  // across.
  //
  // Now: keyword × location, cycled from where the last pass ended, until the time budget, the
  // post target or the contact cap says stop. The loop conditions inside already check all
  // three, so this only removes the artificial ceiling — nothing here can overrun a budget.
  const scanPairs = [];
  for (const kw of plan.keywords.slice(0, dedicated ? plan.keywords.length : 3)) {
    for (const loc of (plan.locations && plan.locations.length ? plan.locations : [''])) {
      scanPairs.push(loc ? `${kw} ${loc}` : kw);
    }
  }
  // Repeated deliberately: a second pass over the same search returns posts published since the
  // first, which is the point of spending an hour on it rather than two minutes.
  const scanQueue = [];
  for (let pass = 0; pass < 12; pass++) scanQueue.push(...scanPairs);
  for (const keyword of scanQueue) {
    if (found >= cap || analysed >= target || Date.now() >= phaseDeadline) break;
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
      // EXPAND EVERY TRUNCATED POST FIRST — the addresses live below the fold.
      //
      // LinkedIn collapses a post after about three lines and hides the rest behind "…see
      // more". A recruiter's post puts the role, the location and the salary up top and
      // "Send resume at name@example.com" near the bottom, so the collapsed text almost never
      // contains the address. That is why 197 posts in one run produced zero emails: they were
      // there, and the page had not rendered them.
      //
      // Clicked page-side by visible label, because LinkedIn's class names are hashed and
      // change on deploy. Every click is independently guarded: one post refusing to expand
      // must not stop the rest, and a post that was never truncated has no control to click.
      await page.evaluate(() => {
        const wanted = /see more|…more|\bmore\b/i;
        for (const n of document.querySelectorAll('button, [role="button"]')) {
          try {
            // Judge the two labels SEPARATELY. LinkedIn's aria-label is a whole sentence —
            // "see more, to open the full post" — so concatenating it with the button text and
            // capping the result at 30 characters rejected the exact control this exists to
            // click. Caught by a fixture built from a real post rather than an invented one.
            // The visible text keeps its cap (a long visible label belongs to some other
            // button); the aria-label is matched on its wording alone.
            const aria = (n.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            const text = (n.innerText || '').replace(/\s+/g, ' ').trim();
            if (!((aria && wanted.test(aria)) || (text && text.length <= 30 && wanted.test(text)))) continue;
            const r = n.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) n.click();
          } catch { /* one stubborn post must not stop the others */ }
        }
      }).catch(() => { /* nothing truncated on this screen */ });
      await humanDelay(600, 1100);

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
        // 80, not 40. This caps how much of the RENDERED feed is read per scroll; with
        // duplicates now filtered out, a low cap here is a hard ceiling on genuinely new posts
        // rather than a defence against re-reading the same ones.
        return els.slice(0, 80).map((el) => {
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
          // The AUTHOR'S HEADLINE, which is what decides whether they are worth contacting.
          //
          // Without it shouldContact() receives an empty string, finds no recruiter title, and
          // falls through to a model call for EVERY post — returning "no" whenever the quota is
          // spent. That turns a safety check into a blanket block: nobody contacted, no reason
          // given. The card text reads "Feed post <Name> • <degree> <headline>", so it is right
          // there; a headline saying "Talent Acquisition" or "Open to work" then settles the
          // question for free.
          let headline = '';
          {
            // "Feed post <Name> • 2nd Lead Bench Sales Recruiter at Interon…" — the headline is
            // whatever follows the connection-degree marker. Verified against live cards.
            // No trailing delimiter is required, deliberately. A headline runs straight into the
            // post body once whitespace is collapsed, so demanding one matched nothing and left
            // every headline empty — which makes shouldContact() fall through to a model call
            // for every post and refuse whenever the quota is spent. A slightly over-long slice
            // is harmless: this is read for the words "Recruiter" or "Open to work", and extra
            // context can only help that.
            const flat = clean(el.innerText);
            const m = flat.match(/•\s*(?:1st|2nd|3rd\+?)\s+(.{3,140})/i) || flat.match(/•\s+(.{3,140})/);
            headline = (m ? m[1] : '').replace(/^(?:1st|2nd|3rd\+?)\s*/i, '').trim().slice(0, 140);
          }
          return { name, headline, link: a?.href || '',
                   authorUrl: /\/in\//.test(authorUrl) ? authorUrl : '',
                   text: (el.innerText || '').slice(0, 4500) };
        });
      }).catch(() => []);
      // COUNT EACH POST ONCE.
      //
      // `posts` is everything currently rendered, re-read after every scroll — so a post near
      // the top of the feed was counted again on each pass. That is how a scan reported "159
      // analysed" in two minutes, roughly a post every 0.75 seconds including the AI intent
      // call, and why only 10 of those 159 ever landed in an outcome bucket: the duplicates
      // were dropped by the outreach `seen` check with a bare `continue`, contributing to
      // nothing. The target of 150 was therefore being "met" by re-reading the same handful of
      // posts, which is also why the flow always finished in two minutes.
      //
      // Keyed on author AND the text, so a recruiter posting twice counts twice while the same
      // post seen five times counts once.
      const fresh = [];
      for (const post of posts) {
        const key = `${post.authorUrl || post.link || ''}|${(post.text || '').slice(0, 80)}`;
        if (postKeys.has(key)) { routed.duplicate++; continue; }
        postKeys.add(key);
        fresh.push(post);
      }
      analysed += fresh.length;
      analysedHere += fresh.length;

      for (const post of fresh) {
        const emails = [...new Set((post.text.match(EMAIL_RE) || []).filter((e) => !EMAIL_JUNK.test(e)))];

        // ROUTE 2 & 3 — no email in the post. Classify the intent once, then send it down the
        // right path instead of discarding it:
        //   · an application/careers link in the text → MANUAL (you click it; we can't fill it)
        //   · otherwise the author's profile          → MESSAGE (outreach contacts them)
        // Most recruiters never put an address in the text, which is why an email-only scan
        // read 150 posts and produced nothing.
        // In email-only mode a post without an address is simply not this flow's business —
        // the post-scan flow already routed it to a message or a manual link.
        // NOT "not hiring" — no address in the text, which is a different fact entirely.
        //
        // Counting these as notHiring reported "117 not actually hiring" for a scan that had
        // not judged a single one of them, and made a flow working exactly as designed look
        // like a broken classifier. Recruiters almost never put an email in a post, so this is
        // the ordinary case and the honest number to show.
        // No address in the post? Then look where a person would look: the author's PROFILE.
        //
        // The scan only ever read the post text, and recruiters almost never put an address
        // there — one run counted 117 posts as having no address and sent 0 emails all day.
        // Their contact panel and About section are where people actually publish it.
        //
        // Only in the email flow, and only with an author to open: this costs a page load per
        // author, and spending that on the post-scan flow (which already has a message route)
        // would double the request rate for a route it does not need. Confined to the flow
        // whose entire job is finding an address.
        if (emails.length === 0 && plan.emailOnly && post.authorUrl && found < cap) {
          const fromBio = await emailFromProfile(page.context(), post.authorUrl).catch(() => '');
          if (fromBio) {
            emails.push(fromBio);
            logEvent('outreach', { found: 'email-in-profile', author: post.name || null });
          }
        }
        if (emails.length === 0 && plan.emailOnly) { routed.noAddress++; continue; }

        if (emails.length === 0 && found < cap) {
          const key = post.authorUrl || post.link;
          // Was: a bare `continue`, so a post whose author we had already contacted left no
          // trace in any bucket and the printed numbers could not be made to add up.
          if (!key) { routed.skipped++; continue; }
          if (seen.has(key)) { routed.alreadyContacted++; continue; }
          const intent = await api.postIntent(post.text).catch(() => ({ isHiring: false }));
          if (!intent.isHiring || (intent.confidence ?? 0) < (plan.personConfMin ?? 80)) {
            routed.notHiring++;
            seen.add(key);
            continue;
          }
          seen.add(key);
          hiringPosts++;
          const applyLink = findApplyLink(post.text);

          // THE LADDER, worked in the order a person would work it:
          //   1. an address anywhere — the post text, then the author's profile → EMAIL
          //   2. a reachable author                                             → MESSAGE
          //   3. nothing but a link                                             → MANUAL
          //
          // The apply-link branch used to come FIRST, so a post carrying both a careers link
          // and a reachable recruiter was filed as a manual lead and the recruiter was never
          // contacted — the strongest route losing to the weakest purely because of branch
          // order. A link is what you fall back to when there is nobody to talk to, not a
          // reason to stop looking for someone.
          if (post.authorUrl) {
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
            // Refused by the wall, but the post still carries a link? It is an opening either
            // way. Dropping it entirely because we declined to message the author throws away
            // a real lead over a contact decision that has nothing to do with the job.
            if (!person.ok && applyLink) {
              routed.manual++;
              console.log(`     🔗 ${post.name || 'someone'} — apply link: ${applyLink.slice(0, 60)}`);
              await api.event({ runId: state.runId, portal: 'linkedin', type: 'manual_apply',
                title: intent.role || 'Hiring post', company: '', url: applyLink,
                detail: `${post.name || 'author'} posted an application link — apply manually` });
            }
          } else if (applyLink) {
            // Nobody to contact, but there IS somewhere to apply. Nothing here can fill an
            // arbitrary external form, and pretending otherwise would lose the opportunity
            // silently — so it becomes a manual lead in the daily digest.
            routed.manual++;
            console.log(`     🔗 ${post.name || 'someone'} — apply link: ${applyLink.slice(0, 60)}`);
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'manual_apply',
              title: intent.role || 'Hiring post', company: '', url: applyLink,
              detail: `${post.name || 'author'} posted an application link — apply manually` });
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
  if (routed.alreadyContacted) console.log(`        ·  ${routed.alreadyContacted} already contacted before`);
  if (routed.noAddress) console.log(`        ·  ${routed.noAddress} no address in the post`);
  if (routed.skipped) console.log(`        ·  ${routed.skipped} skipped (no author link to act on)`);
  if (routed.duplicate) console.log(`        ·  ${routed.duplicate} re-reads of a post already counted`);
  // The numbers must ADD UP. "159 analysed" against ten outcomes was the visible symptom of a
  // count that meant something different from what it said, and nothing checked it.
  {
    const bucketed = routed.email + routed.message + routed.manual + routed.notHiring
      + routed.noAddress + routed.skipped + routed.alreadyContacted;
    if (bucketed !== analysed) {
      logEvent('post-scan', { unaccounted: analysed - bucketed, analysed, ...routed });
      fault('POSTS_UNACCOUNTED', { analysed, bucketed, ...routed });
    }
  }
  if (routed.noAddress) {
    console.log(`        ·  ${routed.noAddress} had no email address in the post (normal — most don't)`);
  }
  if (routed.skipped) console.log(`        ⊘  ${routed.skipped} already contacted (limit or duplicate)`);
  if (analysed < target && !state.stopped && !state.paused) {
    console.log(`        (short of target — the block ran out of time or LinkedIn ran out of posts)`);
  }
  await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
    detail: `post scan: ${analysed}/${target} analysed — ${routed.email} emailed, `
      + `${routed.message} to message, ${routed.manual} manual link(s), ${routed.notHiring} not hiring, `
      + `${routed.noAddress} without an address` });
  return routed;
}

/** Walk LinkedIn's multi-step Easy Apply modal. Returns applied|external|attention|none. */
let easyApplyDiagShown = false;
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
async function recycleIfBloated(state) {
  const mb = await browserMemoryMB().catch(() => 0);
  if (!mb) return;                                   // unmeasurable platform — never block on it
  state.lastBrowserMB = mb;
  if (mb < BROWSER_MEMORY_LIMIT_MB) return;
  logEvent('lifecycle', { event: 'recycle requested', memoryMB: mb,
    limitMB: BROWSER_MEMORY_LIMIT_MB });
  console.log(`
     ♻ the automation browser is using ${(mb / 1024).toFixed(1)} GB — `
    + 'restarting it before it runs the machine out of memory.');
  throw new Error(RECYCLE_SIGNAL);
}

async function easyApply(page, api, profile, state) {
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
    // Which resume the PORTAL has attached. Observed and recorded, never uploaded, and it
    // does NOT gate the submit.
    //
    // The previous guard held an application whenever it could not confirm an upload of OUR
    // copy of the resume — but LinkedIn arrives with the member's own saved resume already
    // selected and never echoes our filename back, so the confirmation could not arrive in the
    // normal case. Every job paused on "the resume did not finish uploading" while the right
    // resume sat attached on screen. LinkedIn holds the file and will not accept its own form
    // without one; JobPilot's job is to record which one went, not to supply it.
    const attached = await observeResume(page, modal).catch(() => ({ attached: false, name: null }));
    state.resumeName = attached.name;
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
      // Controls that LOOK like an advance but leave the application behind. "Review job post"
      // sits in the same modal as "Continue applying" and matches /^review\b/ perfectly well —
      // clicking it navigates back to the posting and the half-filled form is gone. Checked
      // before the match, so no pattern can ever reach these however it is written later.
      const NEVER = /review job post|^dismiss|^back\b|^discard|save (?:and )?(?:exit|for later)|^cancel/;
      for (let i = 0; i < ns.length; i++) {
        const n = ns[i];
        const label = ((n.getAttribute('aria-label') || '') + ' ' + (n.innerText || ''))
          .replace(/\s+/g, ' ').trim().toLowerCase();
        if (!label || NEVER.test(label) || !re.test(label)) continue;
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

    // NOTE the doubled backslashes. These patterns are STRINGS handed to `new RegExp` page-side,
    // and in a JS string literal `\b` is a backspace character (U+0008), not a word boundary. So
    // `'^submit\b'` compiled to "^submit<BACKSPACE>" and could never match anything — three of
    // the five alternatives below were dead on arrival, silently. Only the ones without `\b`
    // ever worked, which is why a modal offering "Continue applying" was reported as having no
    // control we recognise while the diagnostic printed the button right there.
    const submitAt = await pickIndex('^submit application|^submit\\b|submit application');
    if (submitAt >= 0 && await clickIndex(submitAt)) {
      state.action = 'Easy Apply — submitting';
      await humanDelay(1500, 2600);
      await dismissPostSubmit(page);
      return 'applied';
    }
    // "Review" comes before Submit on the last step; treat it as another advance.
    //
    // "continue applying" is LinkedIn's safety-tips interstitial — it appears before the form on
    // some postings, and its button text reads in full:
    //     "I understand the tips and want to continue the apply process Continue applying"
    // so it matches nowhere near the start of the label. Matched anywhere, not anchored.
    //
    // The bare words ARE anchored and word-bounded on purpose. That same modal also offers
    // "Review job post", which navigates out of the apply flow entirely — an unanchored
    // /review/ would click it and lose the application. See the deny-list in pickIndex.
    const nextAt = await pickIndex(
      'continue applying|continue to next step|review your application'
      + '|^continue$|^next$|^review$|^continue\\b|^next\\b|^review\\b');
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
      fault('APPLY_FORM_UNRECOGNISED', { step, url: page.url() });
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
