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
import { shouldApply } from '../gate.js';

// You already searched YOUR keywords with the Easy-Apply filter on, so a listing here is
// something you asked for. We don't re-gate it hard on a keyword-overlap number (that
// silently skipped everything). We only skip the two clear cases: an obviously senior role,
// or a posting we could read well AND that scored genuinely poor. Anything else we apply to
// — trusting your own search, the way a person would.
const FIT_THRESHOLD = 25;
const SENIOR_RE = /\b(senior|sr\.?|lead|principal|staff|architect|manager|director|head\s+of|vp|vice\s*president)\b/i;

// LinkedIn pages at 25 results and offsets with `start`. Reading only page 1 capped every
// search at 25 regardless of how many matches existed.
const PAGES_PER_SEARCH = 3;

function searchUrl(keyword, location, start = 0, maxAgeDays = 0) {
  const p = new URLSearchParams({ keywords: keyword, f_AL: 'true', sortBy: 'DD' }); // f_AL = Easy Apply only
  if (location && location.toLowerCase() !== 'remote') p.set('location', location);
  else p.set('f_WT', '2'); // remote
  if (start > 0) p.set('start', String(start));
  // f_TPR=r<seconds> — "posted within". Keeps months-old, almost certainly filled postings out.
  if (maxAgeDays > 0) p.set('f_TPR', `r${Math.round(maxAgeDays * 86400)}`);
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
    return nodes.map((n) => {
      const id = n.getAttribute('data-occludable-job-id') || n.getAttribute('data-job-id')
        || (n.querySelector('[data-job-id]') && n.querySelector('[data-job-id]').getAttribute('data-job-id'));
      const t = n.querySelector('.job-card-list__title, .job-card-list__title--link, .artdeco-entity-lockup__title, a.job-card-container__link');
      const c = n.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, .job-card-container__company-name');
      return { id, title: clean(t && (t.getAttribute('aria-label') || t.textContent)), company: clean(c && c.textContent) };
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
  return {
    title: await text('.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, h1'),
    company: await text('.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name'),
    location: await text('.job-details-jobs-unified-top-card__primary-description-container, .jobs-unified-top-card__bullet'),
    description: await text('#job-details, .jobs-description__content, .jobs-box__html-content'),
    salary,
  };
}

// The job detail pane — used both to confirm a job actually loaded and to scroll the top
// card (where the Easy Apply button lives) into view.
const PANE_SEL = '.job-details-jobs-unified-top-card, .jobs-unified-top-card, .jobs-details, .jobs-search__job-details';

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
  const dailyTarget = plan.dailyTarget || applyCap;
  const doneToday = plan.appliedToday || 0;
  const phase1Deadline = Date.now() + Math.max(plan.phase1Minutes || 90, 5) * 60_000;
  // Jobs already handled THIS RUN. LinkedIn returns the same posting in every city search, so
  // without this the worker re-opened and re-answered the same job 5-6 times (the HeadSpin /
  // Jobgether rows repeating in Hyderabad, Chennai, Remote, Mumbai…) and burned the hour on
  // duplicates instead of reaching new jobs.
  const doneJobs = new Set();

  // ── PHASE 1 — Easy Apply (skipped entirely by a strict 'outreach' block). ──
  if (mode !== 'outreach' && applyCap > 0) {
    console.log(`\n  ══ Phase 1: Easy Apply — ${doneToday}/${dailyTarget} done today, ${applyCap} to go (max ${plan.phase1Minutes || 90}m) ══`);
    outer:
    for (const keyword of plan.keywords) {
      for (const location of plan.locations) {
        if (state.stopped || state.paused || Date.now() > phase1Deadline || applied >= applyCap) break outer;

      state.action = `Opening LinkedIn Easy-Apply search: "${keyword}" in ${location}`;
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: state.action });
      await page.goto(searchUrl(keyword, location, 0, maxAgeDays), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForResults(page);

      const cards = await collectJobCards(page);
      // Walk further result pages. collectJobCards already collapses reposts, so the stop
      // condition is "this page added nothing new", the same rule Indeed uses.
      const seenIds = new Set(cards.map((c) => c.id));
      for (let pg = 1; pg < PAGES_PER_SEARCH; pg++) {
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
        if (state.stopped || state.paused || Date.now() > phase1Deadline || applied >= applyCap) break outer;
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
          // Load the job's detail pane. Clicking the card is the fast SPA path, but the click
          // can silently do nothing — and then we'd read the PREVIOUS job's pane (or an empty
          // one), which is what made every job log "matched your search" instead of a real fit
          // and left Easy Apply undiscoverable. So wait for the pane, and fall back to the
          // job's own URL when it doesn't appear.
          const card = await page.$(`li[data-occludable-job-id="${id}"], div[data-job-id="${id}"]`);
          let pane = false;
          if (card) {
            await card.click({ timeout: 3000 }).catch(() => {});
            pane = await page.waitForSelector(PANE_SEL, { timeout: 6000 }).then(() => true).catch(() => false);
          }
          if (!pane) {
            await page.goto(`https://www.linkedin.com/jobs/view/${id}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
            pane = await page.waitForSelector(PANE_SEL, { timeout: 8000 }).then(() => true).catch(() => false);
          }
          if (!pane) {
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'error',
              url: `https://www.linkedin.com/jobs/view/${id}/`,
              detail: 'job page would not load (LinkedIn layout change or logged out) — skipped' });
            continue;
          }
          await humanDelay(1200, 2400);

          const post = await readPosting(page);
          // Fall back to the card's title/company if the detail pane didn't render — never log a
          // "Role"/"Company" blank.
          title = post.title || cardInfo.title || '';
          company = post.company || cardInfo.company || '';
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

  // ── PHASE 2 — apply quota met (or no more jobs): spend the rest of the block on OUTREACH. ──
  // Scan hiring posts for recruiter emails (the backend then mails them a tailored note + your
  // résumé) and send/di follow-up LinkedIn connections + messages.
  if (!state.stopped && !state.paused && Date.now() < deadline) {
    if (applyCap === 0) console.log(`\n  ✓ Today's ${dailyTarget} LinkedIn applications are already done — all remaining time goes to outreach.`);
    console.log(`\n  ══ Phase 2: Outreach (${doneToday + applied}/${dailyTarget} applied today) — connections, messages, HR emails ══`);
    try { await scanHiringPosts(page, api, plan, state, true); }  // dedicated = true → the big scan
    catch (e) { await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: `post scan ended: ${String(e).slice(0, 120)}` }); }
    if (plan.autoMessage !== false) {
      try {
        await sendConnectionRequests(page, api, plan, state, resume);
        await checkAcceptances(page, api, state);
        await sendApprovedMessages(page, api, resume, state);
        // The staged sequence for people who accepted earlier — Day 1 → 2 → 5 → 10, then
        // archived. Runs last so a fresh invite this block isn't followed up in the same hour.
        await sendFollowUps(page, api, resume, state, plan);
      } catch (e) {
        await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: `outreach ended: ${String(e).slice(0, 120)}` });
      }
    } else {
      console.log('     (Auto-message is OFF — enable it on the Connections page to send invites + messages)');
    }
  }
  return { applied, ...tally };
}

// ---- Phase 1: hiring-post scan → HR email extraction ------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Obvious non-recruiter addresses — never lead on these.
const EMAIL_JUNK = /no-?reply|example\.|linkedin\.com|\.png$|\.jpe?g$|\.gif$|support@|help@|info@linkedin/i;

/**
 * Search LinkedIn CONTENT (posts) for each keyword, scroll a few pages, and pull
 * recruiter emails out of hiring posts. Each email goes to the backend as a lead with
 * the post text, so the engine can tailor + auto-email an application. Time-boxed and
 * capped so it never eats the Easy Apply phase.
 */
async function scanHiringPosts(page, api, plan, state, dedicated = false) {
  // Dedicated outreach phase (after the apply quota) is UNCAPPED — it scans every keyword,
  // scrolls deep, and keeps harvesting recruiter emails until the block's time runs out.
  const cap = dedicated ? Infinity : 8;
  const scrolls = dedicated ? 25 : 4;
  const phaseDeadline = Date.now() + (dedicated ? (plan.blockMinutes || 120) * 60_000 : 8 * 60_000);
  let found = 0;
  let analysed = 0;
  let hiringPosts = 0;   // posts classified as real openings (no email needed)
  const seen = new Set();
  console.log(`\n  🔎 Scanning hiring posts for recruiter emails (${cap === Infinity ? 'no cap' : 'up to ' + cap})…`);

  for (const keyword of plan.keywords.slice(0, dedicated ? plan.keywords.length : 3)) {
    if (state.stopped || state.paused || Date.now() > phaseDeadline || found >= cap) break;
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
    for (let scroll = 0; scroll < scrolls && found < cap && Date.now() < phaseDeadline; scroll++) {
      // read every post currently rendered
      // Class-independent: try the known post containers, but if LinkedIn has renamed them
      // (which is why this reported "scanned 0 posts"), fall back to the WHOLE PAGE as one
      // blob — we only need the text to mine recruiter emails out of it.
      const posts = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        let els = [...document.querySelectorAll(
          'div.feed-shared-update-v2, li.artdeco-card, [data-urn*="activity"], [data-id*="activity"], div[data-view-name*="feed"]')];
        if (els.length === 0) {
          const body = document.body;
          return body ? [{ name: '', link: location.href, text: (body.innerText || '').slice(0, 60000) }] : [];
        }
        return els.slice(0, 40).map((el) => {
          const a = el.querySelector('a[href*="/feed/update/"], a[href*="/posts/"]');
          const nameEl = el.querySelector('.update-components-actor__title span[aria-hidden], .update-components-actor__title, a[href*="/in/"]');
          const authorA = el.querySelector('a[href*="/in/"]');
          const authorUrl = authorA ? (authorA.href || '').split('?')[0] : '';
          return { name: clean(nameEl?.textContent).slice(0, 60), link: a?.href || '',
                   authorUrl: /\/in\//.test(authorUrl) ? authorUrl : '',
                   text: (el.innerText || '').slice(0, 4500) };
        });
      }).catch(() => []);
      analysed += posts.length;
      analysedHere += posts.length;

      for (const post of posts) {
        const emails = [...new Set((post.text.match(EMAIL_RE) || []).filter((e) => !EMAIL_JUNK.test(e)))];

        // A post with no email address used to be worth nothing — which is why 150 posts
        // yielded 0 leads. Most recruiters never put an address in the text; the opening is
        // still real, and the author is still worth contacting. Classify the intent, and when
        // it IS an opening, capture the author as a lead with the post as the opener.
        if (emails.length === 0 && post.authorUrl && found < cap) {
          if (seen.has(post.authorUrl)) continue;
          const intent = await api.postIntent(post.text).catch(() => ({ isHiring: false }));
          if (intent.isHiring && (intent.confidence ?? 0) >= (plan.personConfMin ?? 80)) {
            seen.add(post.authorUrl);
            hiringPosts++;
            await api.upsertContact({
              portal: 'linkedin', name: post.name, profileUrl: post.authorUrl,
              company: '', role: intent.role || 'hiring post author',
              sourceJobUrl: post.link || undefined,
            }).catch(() => {});
            console.log(`     📣 ${post.name || 'someone'} is hiring — ${intent.topic || intent.role || 'an opening'}`);
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'post_analysed',
              title: intent.role || 'Hiring post', url: post.link || post.authorUrl,
              detail: `${post.name || 'author'} — ${intent.topic || 'posted an opening'} (${intent.confidence}% sure)` });
          }
          continue;
        }

        for (const email of emails) {
          if (seen.has(email.toLowerCase()) || found >= cap) continue;
          seen.add(email.toLowerCase());
          state.action = `HR email found: ${email}`;
          const r = await api.hrLead({
            portal: 'linkedin', email, name: post.name,
            url: post.link || page.url(),
            title: post.text.split('\n').find((l) => l.trim().length > 10)?.slice(0, 90) || 'hiring post',
            postText: post.text,
          }).catch(() => ({ ok: false }));
          if (r.ok && !r.duplicate) {
            found++;
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
  console.log(`     scanned ${analysed} post(s) → ${found} recruiter email(s) · ${hiringPosts} hiring author(s) captured`);
  if (found > 0) {
    await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
      detail: `post scan done — ${found} HR lead(s) captured` });
  }
}

/** Walk LinkedIn's multi-step Easy Apply modal. Returns applied|external|attention|none. */
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

    // Submit if we can; otherwise advance. Scoped to the modal so we click ITS buttons.
    const submit = await modal.$('button[aria-label="Submit application"]');
    if (submit) {
      state.action = 'Easy Apply — submitting';
      await submit.click({ timeout: 4000 }).catch(() => {});
      await humanDelay(1500, 2600);
      await dismissPostSubmit(page);
      return 'applied';
    }
    const next = await modal.$('button[aria-label="Continue to next step"], button[aria-label="Review your application"]');
    if (next) {
      state.action = `Easy Apply — step ${step + 1} done, continuing`;
      await next.click({ timeout: 4000 }).catch(() => {}); await humanDelay(1200, 2200); continue;
    }

    // no recognizable control — bail safely
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
