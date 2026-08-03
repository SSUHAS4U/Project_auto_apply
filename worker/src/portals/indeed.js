// Indeed adapter. Drives Indeed's native "Apply now" (Indeed Apply / smartapply) on the
// owner's logged-in session — the multi-step apply flow, answering screening questions
// from the profile/AI. Jobs that redirect to an employer site ("Apply on company site")
// are skipped. Indeed is aggressive about bot detection, so this is deliberately slow and
// conservative; if a captcha/checkpoint appears it stops and flags "needs attention".
import { humanDelay, sleep } from '../browser.js';
import { logJobHeader, logSkipped, logResult, beginJob } from '../log.js';
import { fillForm, fillChoices, fillDropdowns, uploadResume } from '../fill.js';

// See linkedin.js: the search already used YOUR keywords, so we don't hard-gate on a
// keyword-overlap number. Skip only clearly senior roles or postings we read well that
// scored genuinely poor; apply to the rest.
const FIT_THRESHOLD = 25;
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

function searchUrl(keyword, location, profile) {
  const p = new URLSearchParams({ q: keyword, sort: 'date' });
  if (location && location.toLowerCase() !== 'remote') p.set('l', location);
  else p.set('l', 'Remote');
  return `https://${hostFor(location, profile)}/jobs?${p.toString()}`;
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
    title: await text('h1.jobsearch-JobInfoHeader-title, h2.jobTitle, h1'),
    company: await text('[data-testid="inlineHeader-companyName"], .jobsearch-CompanyInfoContainer a'),
    location: await text('[data-testid="inlineHeader-companyLocation"], [data-testid="job-location"]'),
    description: await text('#jobDescriptionText, .jobsearch-JobComponent-description'),
    salary: (await text('#salaryInfoAndJobType [data-testid="attribute_snippet_testid"], #salaryInfoAndJobType .attribute_snippet, .jobsearch-JobMetadataHeader-item'))
      .replace(/\s+/g, ' ').slice(0, 90),
  };
}

async function looksBlocked(page) {
  const html = (await page.content().catch(() => '')).toLowerCase();
  return html.includes('verify you are human') || html.includes('captcha') || html.includes('unusual traffic');
}

export async function runIndeed(page, api, plan, state, ctx) {
  const profile = await api.profile().catch(() => ({}));
  const resume = await api.resume().catch(() => ({ hasResume: false }));
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

  // ONE country host for the whole run — used for the searches AND the job pages. The job page
  // used to be hardcoded to www.indeed.com while the search ran on in.indeed.com, so every job
  // opened on the US site, redirected, and was silently dropped: "16 results" then nothing.
  const host = hostFor((plan.locations || [])[0], profile);
  console.log(`\n  Indeed — ${doneToday}/${dailyTarget} done today, ${applyCap} to go · ${blockMin}min block · ${host}`);
  if (applyCap === 0) { console.log("  ✓ Today's Indeed quota is already met — nothing to do."); return { applied: 0 }; }
  let totalResults = 0;
  let diagShown = false;   // dump the page diagnostics once, not on every empty search
  // Indeed returns the same postings for every city (16 each time in the last run), so without
  // this the worker re-opened and re-processed the identical 16 jobs six times over.
  const doneJobs = new Set();
  outer:
  for (const keyword of plan.keywords) {
    for (const location of plan.locations) {
      if (state.stopped || state.paused || Date.now() > deadline || applied >= applyCap) break outer;

      state.action = `Searching Indeed "${keyword}" in ${location}`;
      await api.event({ runId: state.runId, portal: 'indeed', type: 'info', detail: state.action });
      await page.goto(searchUrl(keyword, location, profile), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await humanDelay(2800, 5000);
      // Signed in? Indeed shows job cards to guests too, but apply needs a session — and the
      // page layout differs, which can silently yield zero cards.
      const url = page.url();
      const loggedOut = /\/account\/login|secure\.indeed\.com|\/hp\?/i.test(url);

      if (await looksBlocked(page)) {
        blockedStreak++;
        state.action = 'Indeed checkpoint — needs attention';
        // Previously this looped per keyword×location and flooded the activity feed with
        // hundreds of identical errors. Three walls in a row = Indeed is not letting us in
        // this session: flag needs_attention (rings the bell) and END the block cleanly.
        if (blockedStreak >= 3) {
          await api.event({ runId: state.runId, portal: 'indeed', type: 'error',
            detail: 'checkpoint/captcha persists — pausing Indeed for this block. Solve it in the browser, then run again.' });
          await api.runStatus(state.runId, 'needs_attention', 'Indeed captcha — solve it in the browser').catch(() => {});
          return { applied };
        }
        await api.event({ runId: state.runId, portal: 'indeed', type: 'error',
          detail: 'checkpoint/captcha — solve it in the browser, then it resumes' });
        await sleep(15000);
        continue;
      }
      blockedStreak = 0;

      const keys = await collectJobKeys(page);
      totalResults += keys.length;
      console.log(`  🔎 ${keyword} · ${location} → ${keys.length} result(s)${keys.length === 0 && loggedOut ? '  ⚠ looks signed-out' : ''}`);
      if (keys.length === 0 && !diagShown) { diagShown = true; await describeSearch(page).catch(() => {}); }
      await api.event({ runId: state.runId, portal: 'indeed', type: 'info',
        detail: `${keys.length} results for ${keyword} @ ${location}` });

      for (const jk of keys) {
        if (state.stopped || state.paused || Date.now() > deadline || applied >= applyCap) break outer;
        if (doneJobs.has(jk)) continue;   // already handled this run (another city's search)
        doneJobs.add(jk);
        const jobPage = await ctx.newPage();
        try {
          await jobPage.goto(`https://${host}/viewjob?jk=${jk}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await humanDelay(1800, 3200);
          if (await looksBlocked(jobPage)) { await jobPage.close(); continue; }

          const post = await readPosting(jobPage);
          state.action = `Reviewing: ${post.title}`;
          await api.event({ runId: state.runId, portal: 'indeed', type: 'job_identified',
            title: post.title, company: post.company, url: `https://${host}/viewjob?jk=${jk}`,
            salary: post.salary, description: (post.description || '').replace(/\s+/g, ' ').slice(0, 400) });

          const { score } = await api.evaluate(post).catch(() => ({ score: 0 }));
          const canJudge = (post.description || '').length > 60;
          if (SENIOR_RE.test(post.title || '')) {
            await api.event({ runId: state.runId, portal: 'indeed', type: 'info',
              title: post.title, company: post.company, detail: 'skip — senior/leadership role' });
            logSkipped(post.title || 'Role', 'senior/leadership role');
            continue;
          }
          if (canJudge && score < FIT_THRESHOLD) {
            await api.event({ runId: state.runId, portal: 'indeed', type: 'info',
              title: post.title, company: post.company, detail: `skip — low fit ${score}` });
            logSkipped(post.title || 'Role', `low fit ${score}`);
            continue;
          }
          await api.event({ runId: state.runId, portal: 'indeed', type: 'relevant',
            title: post.title, company: post.company,
            detail: canJudge ? `fit ${score}` : 'matched your search — applying' });

          logJobHeader(post.title || 'Role', post.company || '', canJudge ? `fit ${score}` : 'no description');
          beginJob();
          const result = await indeedApply(jobPage, api, profile, resume, state, ctx);
          logResult(result === 'applied' ? 'applied' : result === 'external' ? 'external'
            : result === 'attention' ? 'attention' : 'none');
          if (result === 'applied') {
            applied++;
            await api.event({ runId: state.runId, portal: 'indeed', type: 'easy_apply',
              title: post.title, company: post.company, url: `https://${host}/viewjob?jk=${jk}`, detail: `fit ${score}` });
          } else if (result === 'external') {
            await api.event({ runId: state.runId, portal: 'indeed', type: 'manual_apply',
              title: post.title, company: post.company,
              url: `https://${host}/viewjob?jk=${jk}`, detail: `fit ${score} — apply manually (employer site)` });
          } else if (result === 'attention') {
            await api.event({ runId: state.runId, portal: 'indeed', type: 'info',
              title: post.title, company: post.company, detail: 'needs attention — an unanswerable question' });
          } else {
            // Same silent-drop bug as LinkedIn had: anything that wasn't applied/external
            // emitted NOTHING, so the job disappeared with no counter and no error.
            await api.event({ runId: state.runId, portal: 'indeed', type: 'manual_apply',
              title: post.title, company: post.company,
              url: `https://${host}/viewjob?jk=${jk}`, detail: 'no Indeed Apply button found — apply manually' });
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
  // If EVERY search returned zero, say why in plain terms rather than a silent 0/0/0/0/0.
  if (totalResults === 0) {
    console.log('\n  ✋ Indeed returned no jobs for any search. Usual causes:');
    console.log('     · not signed in to Indeed in the automation browser (log in once, then run again)');
    console.log('     · a captcha / "verify you are human" wall');
    console.log('     · Indeed changed its results markup');
    await api.event({ runId: state.runId, portal: 'indeed', type: 'error',
      detail: 'Indeed returned no jobs — sign into indeed.com in the automation browser (or solve the captcha), then run again.' });
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
    // Indeed's screening step is radio-group based too — fillForm skips those.
    const { attention: choiceAttention } = await fillChoices(applyPage, api);
    // Custom dropdowns — pick the closest option from what the dropdown offers.
    const { attention: dropAttention } = await fillDropdowns(applyPage, profile, api);
    attention.push(...choiceAttention, ...dropAttention);
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
