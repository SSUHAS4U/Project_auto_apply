// LinkedIn adapter. Drives LinkedIn's native **Easy Apply** on the owner's logged-in
// session. Searches with the Easy-Apply filter (f_AL=true) so we only open jobs we can
// actually one-click apply to, walks the multi-step Easy Apply modal, answers screening
// questions from the profile/AI, and (optionally) sends a connection request afterward.
// Conservative by design — human delays, caps, stop-on-pause; never touches external
// "Apply on company website" links.
import { humanDelay, sleep } from '../browser.js';
import { fillForm, uploadResume } from '../fill.js';
import { sendConnectionRequests, checkAcceptances, sendApprovedMessages } from './outreach.js';

// You already searched YOUR keywords with the Easy-Apply filter on, so a listing here is
// something you asked for. We don't re-gate it hard on a keyword-overlap number (that
// silently skipped everything). We only skip the two clear cases: an obviously senior role,
// or a posting we could read well AND that scored genuinely poor. Anything else we apply to
// — trusting your own search, the way a person would.
const FIT_THRESHOLD = 25;
const SENIOR_RE = /\b(senior|sr\.?|lead|principal|staff|architect|manager|director|head\s+of|vp|vice\s*president)\b/i;

function searchUrl(keyword, location) {
  const p = new URLSearchParams({ keywords: keyword, f_AL: 'true', sortBy: 'DD' }); // f_AL = Easy Apply only
  if (location && location.toLowerCase() !== 'remote') p.set('location', location);
  else p.set('f_WT', '2'); // remote
  return `https://www.linkedin.com/jobs/search/?${p.toString()}`;
}

const CARD_SELECTOR =
  'li[data-occludable-job-id], div.job-card-container[data-job-id], li.jobs-search-results__list-item, [data-job-id]';

async function waitForResults(page) {
  await page.waitForSelector(CARD_SELECTOR, { timeout: 18000 }).catch(() => {});
  await page.waitForTimeout(1200).catch(() => {});
}

async function collectJobCards(page) {
  // The results rail; ids live on the <li> or a data attribute. LinkedIn changes these
  // often, so cast a wide net.
  const ids = await page.$$eval(CARD_SELECTOR,
    (nodes) => nodes.map((n) => n.getAttribute('data-occludable-job-id')
      || n.getAttribute('data-job-id')
      || (n.querySelector('[data-job-id]') && n.querySelector('[data-job-id]').getAttribute('data-job-id'))).filter(Boolean),
  ).catch(() => []);
  return [...new Set(ids)];
}

async function readPosting(page) {
  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => '');
  return {
    title: await text('.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, h1'),
    company: await text('.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name'),
    location: await text('.job-details-jobs-unified-top-card__primary-description-container, .jobs-unified-top-card__bullet'),
    description: await text('#job-details, .jobs-description__content, .jobs-box__html-content'),
  };
}

export async function runLinkedIn(page, api, plan, state, ctx) {
  const profile = await api.profile().catch(() => ({}));
  const resume = await api.resume().catch(() => ({ hasResume: false }));
  const deadline = Date.now() + (plan.blockMinutes || 120) * 60_000;
  let applied = 0;

  // Every run scans hiring posts first (harvests recruiter emails → the backend auto-emails
  // a tailored application). It's short in 'apply' mode and gets the whole slot in 'outreach'
  // mode. Only a strict 'outreach' block stops there; otherwise we go on to Easy Apply.
  const mode = plan.mode || 'all';
  try { await scanHiringPosts(page, api, plan, state, mode === 'outreach'); }
  catch (e) { await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: `post scan ended: ${String(e).slice(0, 120)}` }); }

  // Connection outreach (gated by the Auto-message toggle). Every run FOLLOWS UP any invites
  // that were accepted — marks them connected and DMs them with the résumé attached. New
  // invites go out in outreach/default blocks; strict 'apply' blocks stay focused on applying.
  if (plan.autoMessage !== false) {
    try {
      // Send fresh invites on every run (the default block mode is 'apply', so gating this on
      // non-apply meant invites never went out). Bounded by connectCap inside the function.
      await sendConnectionRequests(page, api, plan, state);
      await checkAcceptances(page, api, state);
      await sendApprovedMessages(page, api, resume, state);
    } catch (e) {
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: `outreach ended: ${String(e).slice(0, 120)}` });
    }
  }
  if (mode === 'outreach') return { applied };

  outer:
  for (const keyword of plan.keywords) {
    for (const location of plan.locations) {
      if (state.paused || Date.now() > deadline || applied >= (plan.applyCap || 100)) break outer;

      state.action = `Opening LinkedIn Easy-Apply search: "${keyword}" in ${location}`;
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: state.action });
      await page.goto(searchUrl(keyword, location), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForResults(page);

      const ids = await collectJobCards(page);
      const landed = page.url();
      const needsLogin = /\/login|\/authwall|signup/i.test(landed);
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
        detail: ids.length > 0
          ? `Found ${ids.length} Easy-Apply jobs for "${keyword}" @ ${location}`
          : needsLogin
            ? `LinkedIn asked to log in — sign into linkedin.com in the browser, then run again`
            : `No Easy-Apply results on this search — LinkedIn may have changed the page or need login` });
      if (ids.length === 0) continue;

      for (const id of ids) {
        if (state.paused || Date.now() > deadline || applied >= (plan.applyCap || 100)) break outer;
        try {
          // clicking the card in-place loads the detail pane (SPA)
          const card = await page.$(`li[data-occludable-job-id="${id}"], div[data-job-id="${id}"]`);
          if (card) { await card.click({ timeout: 3000 }).catch(() => {}); }
          else { await page.goto(`https://www.linkedin.com/jobs/view/${id}/`, { waitUntil: 'domcontentloaded' }).catch(() => {}); }
          await humanDelay(1800, 3200);

          const post = await readPosting(page);
          state.action = `Reviewing: ${post.title}`;
          await api.event({ runId: state.runId, portal: 'linkedin', type: 'job_identified',
            title: post.title, company: post.company, url: `https://www.linkedin.com/jobs/view/${id}/` });

          const { score } = await api.evaluate(post).catch(() => ({ score: 0 }));
          const canJudge = (post.description || '').length > 60; // did we actually read the posting?
          if (SENIOR_RE.test(post.title || '')) {
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
              title: post.title, company: post.company, detail: 'skip — senior/leadership role' });
            continue;
          }
          if (canJudge && score < FIT_THRESHOLD) {
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
              title: post.title, company: post.company, detail: `skip — low fit ${score}` });
            continue;
          }
          await api.event({ runId: state.runId, portal: 'linkedin', type: 'relevant',
            title: post.title, company: post.company,
            detail: canJudge ? `fit ${score}` : 'matched your search — applying' });

          const result = await easyApply(page, api, profile, resume, state);
          if (result === 'applied') {
            applied++;
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'easy_apply',
              title: post.title, company: post.company, url: `https://www.linkedin.com/jobs/view/${id}/`, detail: `fit ${score}` });
          } else if (result === 'external') {
            // No Easy Apply → the owner applies by hand; recorded as manual_apply so the
            // dashboard lists it and the daily digest emails it.
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'manual_apply',
              title: post.title, company: post.company,
              url: `https://www.linkedin.com/jobs/view/${id}/`, detail: `fit ${score} — apply manually (external form)` });
          } else if (result === 'attention') {
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
              title: post.title, company: post.company, detail: 'needs attention — an unanswerable question' });
          }
        } catch (e) {
          await api.event({ runId: state.runId, portal: 'linkedin', type: 'error', detail: String(e).slice(0, 160) });
        }
        await humanDelay(2000, 4000);
      }
    }
  }
  return { applied };
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
  // Dedicated outreach block: the whole slot + a bigger lead cap and more keywords.
  const cap = dedicated ? 15 : 5;
  const phaseDeadline = Date.now() + (dedicated ? (plan.blockMinutes || 120) * 60_000 : 8 * 60_000);
  let found = 0;
  const seen = new Set();

  for (const keyword of plan.keywords.slice(0, dedicated ? 5 : 2)) {
    if (state.paused || Date.now() > phaseDeadline || found >= cap) break;
    state.action = `Scanning LinkedIn posts: "${keyword} hiring"`;
    await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: state.action });

    const url = 'https://www.linkedin.com/search/results/content/?keywords='
      + encodeURIComponent(`${keyword} hiring`) + '&sortBy=%22date_posted%22';
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await humanDelay(2500, 4000);
    if (/\/login|\/authwall|signup/i.test(page.url())) return; // not logged in — skip quietly

    for (let scroll = 0; scroll < 4 && found < cap && Date.now() < phaseDeadline; scroll++) {
      // read every post currently rendered
      const posts = await page.$$eval('div.feed-shared-update-v2, li.artdeco-card', (els) =>
        els.slice(0, 30).map((el) => {
          const name = el.querySelector('.update-components-actor__title span[aria-hidden]')?.textContent?.trim() || '';
          const link = el.querySelector('a.app-aware-link[href*="/feed/update/"]')?.href || '';
          return { name, link, text: (el.innerText || '').slice(0, 4500) };
        })).catch(() => []);

      for (const post of posts) {
        const emails = [...new Set((post.text.match(EMAIL_RE) || []).filter((e) => !EMAIL_JUNK.test(e)))];
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
            await api.event({ runId: state.runId, portal: 'linkedin', type: r.applying ? 'email_sent' : 'info',
              title: `HR lead: ${email}`, url: post.link || undefined,
              detail: r.applying ? 'tailoring application — will auto-email when ready' : 'lead saved (auto-email off or post too short)' });
          }
        }
      }
      await page.mouse.wheel(0, 2400).catch(() => {});
      await humanDelay(2200, 3800);
    }
  }
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
  let btn = null;
  for (let i = 0; i < 5 && !btn; i++) {
    btn = await page.$('button.jobs-apply-button:has-text("Easy Apply"), button[aria-label^="Easy Apply"], button[aria-label*="Easy Apply"], button.jobs-apply-button');
    if (!btn) { await scrollTopCardIntoView(page); await humanDelay(700, 1300); }
  }
  if (!btn) {
    // Only call it external when there's an EXPLICIT off-site apply control — never on a
    // loose "Apply" match (that false-positive was sending real Easy-Apply jobs to manual).
    const ext = await page.$('button[aria-label*="Apply on company"], a[aria-label*="Apply on company"], a.jobs-apply-button[href^="http"]');
    return ext ? 'external' : 'none';
  }
  state.action = 'Easy Apply — opening the form';
  await btn.click({ timeout: 4000 }).catch(() => {});
  await humanDelay(1500, 2800);

  for (let step = 0; step < 12; step++) {
    if (state.paused) { await closeModal(page); return 'attention'; }
    const modal = await page.$('.jobs-easy-apply-modal, [data-test-modal][role="dialog"]');
    if (!modal) break;

    // Narrate each step so the live feed caption shows the Easy Apply progressing.
    state.action = `Easy Apply — step ${step + 1} (filling the form)`;
    await uploadResume(page, resume).catch(() => {});
    const { attention } = await fillForm(page, profile, api);
    if (attention.length) {
      // an unanswerable question — don't submit a half-filled application
      await closeModal(page);
      return 'attention';
    }

    // Submit if we can; otherwise advance.
    const submit = await page.$('button[aria-label="Submit application"]');
    if (submit) {
      state.action = 'Easy Apply — submitting';
      await submit.click({ timeout: 4000 }).catch(() => {});
      await humanDelay(1500, 2600);
      await dismissPostSubmit(page);
      return 'applied';
    }
    const next = await page.$('button[aria-label="Continue to next step"], button[aria-label="Review your application"]');
    if (next) {
      state.action = `Easy Apply — step ${step + 1} done, continuing`;
      await next.click({ timeout: 4000 }).catch(() => {}); await humanDelay(1200, 2200); continue;
    }

    // no recognizable control — bail safely
    await closeModal(page);
    return 'attention';
  }
  return 'none';
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
