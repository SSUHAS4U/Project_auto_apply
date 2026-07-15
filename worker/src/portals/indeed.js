// Indeed adapter. Drives Indeed's native "Apply now" (Indeed Apply / smartapply) on the
// owner's logged-in session — the multi-step apply flow, answering screening questions
// from the profile/AI. Jobs that redirect to an employer site ("Apply on company site")
// are skipped. Indeed is aggressive about bot detection, so this is deliberately slow and
// conservative; if a captcha/checkpoint appears it stops and flags "needs attention".
import { humanDelay, sleep } from '../browser.js';
import { fillForm, uploadResume } from '../fill.js';

const FIT_THRESHOLD = 45;

function searchUrl(keyword, location) {
  const p = new URLSearchParams({ q: keyword, sort: 'date' });
  if (location && location.toLowerCase() !== 'remote') p.set('l', location);
  else p.set('l', 'Remote');
  return `https://www.indeed.com/jobs?${p.toString()}`;
}

async function collectJobKeys(page) {
  const keys = await page.$$eval(
    'a.jcs-JobTitle[data-jk], a[data-jk], div.job_seen_beacon a[href*="jk="]',
    (nodes) => nodes.map((n) => n.getAttribute('data-jk')
      || (n.getAttribute('href') || '').match(/jk=([0-9a-f]+)/)?.[1]).filter(Boolean),
  ).catch(() => []);
  return [...new Set(keys)];
}

async function readPosting(page) {
  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => '');
  return {
    title: await text('h1.jobsearch-JobInfoHeader-title, h2.jobTitle, h1'),
    company: await text('[data-testid="inlineHeader-companyName"], .jobsearch-CompanyInfoContainer a'),
    location: await text('[data-testid="inlineHeader-companyLocation"], [data-testid="job-location"]'),
    description: await text('#jobDescriptionText, .jobsearch-JobComponent-description'),
  };
}

async function looksBlocked(page) {
  const html = (await page.content().catch(() => '')).toLowerCase();
  return html.includes('verify you are human') || html.includes('captcha') || html.includes('unusual traffic');
}

export async function runIndeed(page, api, plan, state, ctx) {
  const profile = await api.profile().catch(() => ({}));
  const resume = await api.resume().catch(() => ({ hasResume: false }));
  const deadline = Date.now() + (plan.blockMinutes || 120) * 60_000;
  let applied = 0;

  outer:
  for (const keyword of plan.keywords) {
    for (const location of plan.locations) {
      if (state.paused || Date.now() > deadline || applied >= (plan.applyCap || 80)) break outer;

      state.action = `Searching Indeed "${keyword}" in ${location}`;
      await api.event({ runId: state.runId, portal: 'indeed', type: 'info', detail: state.action });
      await page.goto(searchUrl(keyword, location), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await humanDelay(2800, 5000);

      if (await looksBlocked(page)) {
        state.action = 'Indeed checkpoint — needs attention';
        await api.event({ runId: state.runId, portal: 'indeed', type: 'error',
          detail: 'checkpoint/captcha — solve it in the browser, then it resumes' });
        await sleep(15000);
        continue;
      }

      const keys = await collectJobKeys(page);
      await api.event({ runId: state.runId, portal: 'indeed', type: 'info',
        detail: `${keys.length} results for ${keyword} @ ${location}` });

      for (const jk of keys) {
        if (state.paused || Date.now() > deadline || applied >= (plan.applyCap || 80)) break outer;
        const jobPage = await ctx.newPage();
        try {
          await jobPage.goto(`https://www.indeed.com/viewjob?jk=${jk}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await humanDelay(1800, 3200);
          if (await looksBlocked(jobPage)) { await jobPage.close(); continue; }

          const post = await readPosting(jobPage);
          state.action = `Reviewing: ${post.title}`;
          await api.event({ runId: state.runId, portal: 'indeed', type: 'job_identified',
            title: post.title, company: post.company, url: `https://www.indeed.com/viewjob?jk=${jk}` });

          const { score } = await api.evaluate(post).catch(() => ({ score: 0 }));
          if (score < FIT_THRESHOLD) continue;
          await api.event({ runId: state.runId, portal: 'indeed', type: 'relevant',
            title: post.title, company: post.company, detail: `fit ${score}` });

          const result = await indeedApply(jobPage, api, profile, resume, state, ctx);
          if (result === 'applied') {
            applied++;
            await api.event({ runId: state.runId, portal: 'indeed', type: 'easy_apply',
              title: post.title, company: post.company, url: `https://www.indeed.com/viewjob?jk=${jk}`, detail: `fit ${score}` });
          } else if (result === 'external') {
            await api.event({ runId: state.runId, portal: 'indeed', type: 'info',
              title: post.title, company: post.company, detail: 'employer-site apply — skipped' });
          }
        } catch (e) {
          await api.event({ runId: state.runId, portal: 'indeed', type: 'error', detail: String(e).slice(0, 160) });
        } finally {
          await jobPage.close().catch(() => {});
          await humanDelay(2200, 4200);
        }
      }
    }
  }
  return { applied };
}

/** Indeed Apply is a multi-step flow that often opens on smartapply.indeed.com. */
async function indeedApply(page, api, profile, resume, state, ctx) {
  const btn = await page.$('#indeedApplyButton, button[aria-label*="Apply now"], .ia-IndeedApplyButton, button:has-text("Apply now")');
  if (!btn) return 'external';

  state.action = 'Indeed Apply…';
  const [maybeNew] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null),
    btn.click({ timeout: 4000 }).catch(() => {}),
  ]);
  const applyPage = maybeNew || page; // the flow may open in a new tab
  await humanDelay(1800, 3200);

  for (let step = 0; step < 12; step++) {
    if (state.paused) return 'attention';
    if (await looksBlocked(applyPage)) return 'attention';

    await uploadResume(applyPage, resume).catch(() => {});
    const { attention } = await fillForm(applyPage, profile, api);
    if (attention.length) return 'attention';

    const submit = await applyPage.$('button:has-text("Submit application"), button[type="submit"]:has-text("Submit")');
    if (submit) {
      await submit.click({ timeout: 4000 }).catch(() => {});
      await humanDelay(1500, 2600);
      const done = await applyPage.$('text=/application submitted|your application has been submitted/i');
      if (applyPage !== page) await applyPage.close().catch(() => {});
      return done ? 'applied' : 'applied';
    }
    const cont = await applyPage.$('button:has-text("Continue"), button[aria-label*="Continue"], button:has-text("Next")');
    if (cont) { await cont.click({ timeout: 4000 }).catch(() => {}); await humanDelay(1200, 2200); continue; }
    break;
  }
  if (applyPage !== page) await applyPage.close().catch(() => {});
  return 'attention';
}
