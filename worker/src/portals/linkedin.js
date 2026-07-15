// LinkedIn adapter. Drives LinkedIn's native **Easy Apply** on the owner's logged-in
// session. Searches with the Easy-Apply filter (f_AL=true) so we only open jobs we can
// actually one-click apply to, walks the multi-step Easy Apply modal, answers screening
// questions from the profile/AI, and (optionally) sends a connection request afterward.
// Conservative by design — human delays, caps, stop-on-pause; never touches external
// "Apply on company website" links.
import { humanDelay, sleep } from '../browser.js';
import { fillForm, uploadResume } from '../fill.js';

const FIT_THRESHOLD = 45;

function searchUrl(keyword, location) {
  const p = new URLSearchParams({ keywords: keyword, f_AL: 'true', sortBy: 'DD' }); // f_AL = Easy Apply only
  if (location && location.toLowerCase() !== 'remote') p.set('location', location);
  else p.set('f_WT', '2'); // remote
  return `https://www.linkedin.com/jobs/search/?${p.toString()}`;
}

async function collectJobCards(page) {
  // The results rail; ids live on the <li> or a data attribute.
  const ids = await page.$$eval(
    'li[data-occludable-job-id], div.job-card-container[data-job-id]',
    (nodes) => nodes.map((n) => n.getAttribute('data-occludable-job-id') || n.getAttribute('data-job-id')).filter(Boolean),
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

  outer:
  for (const keyword of plan.keywords) {
    for (const location of plan.locations) {
      if (state.paused || Date.now() > deadline || applied >= (plan.applyCap || 100)) break outer;

      state.action = `Searching LinkedIn "${keyword}" in ${location}`;
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: state.action });
      await page.goto(searchUrl(keyword, location), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await humanDelay(2500, 4500);

      const ids = await collectJobCards(page);
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
        detail: `${ids.length} Easy-Apply results for ${keyword} @ ${location}` });

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
          if (score < FIT_THRESHOLD) {
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
              title: post.title, company: post.company, detail: `skip — fit ${score}` });
            continue;
          }
          await api.event({ runId: state.runId, portal: 'linkedin', type: 'relevant',
            title: post.title, company: post.company, detail: `fit ${score}` });

          const result = await easyApply(page, api, profile, resume, state);
          if (result === 'applied') {
            applied++;
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'easy_apply',
              title: post.title, company: post.company, url: `https://www.linkedin.com/jobs/view/${id}/`, detail: `fit ${score}` });
          } else if (result === 'external') {
            await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
              title: post.title, company: post.company, detail: 'external apply — skipped' });
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

/** Walk LinkedIn's multi-step Easy Apply modal. Returns applied|external|attention|none. */
async function easyApply(page, api, profile, resume, state) {
  const btn = await page.$('button.jobs-apply-button, button[aria-label*="Easy Apply"]');
  if (!btn) {
    // external "Apply" that navigates off-site
    const ext = await page.$('a[aria-label*="Apply"], button[aria-label*="Apply on company"]');
    return ext ? 'external' : 'none';
  }
  state.action = 'Easy Apply…';
  await btn.click({ timeout: 4000 }).catch(() => {});
  await humanDelay(1500, 2800);

  for (let step = 0; step < 12; step++) {
    if (state.paused) { await closeModal(page); return 'attention'; }
    const modal = await page.$('.jobs-easy-apply-modal, [data-test-modal][role="dialog"]');
    if (!modal) break;

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
      await submit.click({ timeout: 4000 }).catch(() => {});
      await humanDelay(1500, 2600);
      await dismissPostSubmit(page);
      return 'applied';
    }
    const next = await page.$('button[aria-label="Continue to next step"], button[aria-label="Review your application"]');
    if (next) { await next.click({ timeout: 4000 }).catch(() => {}); await humanDelay(1200, 2200); continue; }

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
