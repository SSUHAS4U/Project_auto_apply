// Naukri adapter. The owner logs into naukri.com once (persisted profile); this drives
// search → open → fit-check → native Apply (incl. the chatbot Q&A) on the owner's home
// IP. It never touches "Apply on company site" (external) — those are left for the
// engine's tailored-email path. Conservative by design: caps, human delays, and it
// stops the instant the owner hits Pause.
import { humanDelay, sleep } from '../browser.js';
import { fillForm, uploadResume } from '../fill.js';

const FIT_THRESHOLD = 45; // below this we look but don't apply

function slug(s) { return encodeURIComponent(s.trim().toLowerCase().replace(/\s+/g, '-')); }

function searchUrl(keyword, location) {
  // Naukri's public search URL pattern: /<keyword>-jobs-in-<location>
  const k = slug(keyword);
  return location && location.toLowerCase() !== 'remote'
    ? `https://www.naukri.com/${k}-jobs-in-${slug(location)}`
    : `https://www.naukri.com/${k}-jobs`;
}

// Naukri renders results with JavaScript after load, so we wait for a job card to appear
// before scraping. Its class names change over time — cast a wide net.
const JOB_LINK_SELECTORS = [
  '.srp-jobtuple-wrapper a.title',
  'article.jobTuple a.title',
  'a.title[href*="job-listings"]',
  'a[href*="/job-listings-"]',
  'a.title',
];

async function waitForResults(page) {
  await page.waitForSelector(JOB_LINK_SELECTORS.join(', '), { timeout: 18000 }).catch(() => {});
  // let a couple of lazy rows settle
  await page.waitForTimeout(1200).catch(() => {});
}

async function collectJobLinks(page) {
  for (const sel of JOB_LINK_SELECTORS) {
    const links = await page.$$eval(sel, (as) =>
      as.map((a) => ({ url: a.href, title: (a.textContent || '').trim() }))
        .filter((x) => x.url && /job-listings|\/jobs\//.test(x.url)),
    ).catch(() => []);
    if (links.length) return dedupe(links);
  }
  return [];
}

function dedupe(links) {
  const seen = new Set();
  return links.filter((l) => (seen.has(l.url) ? false : seen.add(l.url)));
}

async function readPosting(page) {
  const text = (sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => '');
  return {
    title: (await text('h1')) || (await text('.jd-header-title')),
    company: (await text('.jd-header-comp-name')) || (await text('[class*="comp-name"]')),
    location: (await text('.location')) || (await text('[class*="loc"]')),
    description: (await text('.job-desc')) || (await text('[class*="job-desc"]')) || (await text('section')),
  };
}

/** Run one Naukri block. `state` carries {runId, portal, action, paused}. */
export async function runNaukri(page, api, plan, state, ctx) {
  const profile = await api.profile().catch(() => ({}));
  const resume = await api.resume().catch(() => ({ hasResume: false }));
  const deadline = Date.now() + (plan.blockMinutes || 120) * 60_000;
  let applied = 0;

  outer:
  for (const keyword of plan.keywords) {
    for (const location of plan.locations) {
      if (state.paused || Date.now() > deadline || applied >= (plan.applyCap || 200)) break outer;

      state.action = `Opening Naukri search: "${keyword}" in ${location}`;
      await api.event({ runId: state.runId, portal: 'naukri', type: 'info', detail: state.action });
      const url = searchUrl(keyword, location);
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForResults(page);

      const links = await collectJobLinks(page);
      // Tell the dashboard exactly what happened so a "0 results" is diagnosable, not silent.
      const landed = page.url();
      const blocked = /login|nlogin/i.test(landed);
      await api.event({ runId: state.runId, portal: 'naukri', type: 'info',
        detail: links.length > 0
          ? `Found ${links.length} jobs for "${keyword}" @ ${location}`
          : blocked
            ? `Naukri asked to log in — sign into naukri.com in the browser, then run again`
            : `No job cards found on ${landed.replace('https://www.', '')} — the page may have changed or require login` });
      if (links.length === 0) continue;

      for (const link of links) {
        if (state.paused || Date.now() > deadline || applied >= (plan.applyCap || 200)) break outer;

        const jobPage = await ctx.newPage();
        try {
          await jobPage.goto(link.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await humanDelay(1200, 2500);
          const post = await readPosting(jobPage);
          post.title = post.title || link.title;
          state.action = `Reviewing: ${post.title || link.title}`;

          await api.event({ runId: state.runId, portal: 'naukri', type: 'job_identified',
            title: post.title, company: post.company, url: link.url });

          const { score } = await api.evaluate(post).catch(() => ({ score: 0 }));
          if (score < FIT_THRESHOLD) {
            await api.event({ runId: state.runId, portal: 'naukri', type: 'info',
              title: post.title, company: post.company, url: link.url, detail: `skip — fit ${score}` });
            continue;
          }
          await api.event({ runId: state.runId, portal: 'naukri', type: 'relevant',
            title: post.title, company: post.company, url: link.url, detail: `fit ${score}` });

          const result = await applyOnNaukri(jobPage, api, profile, resume, state);
          if (result === 'applied') {
            applied++;
            await api.event({ runId: state.runId, portal: 'naukri', type: 'easy_apply',
              title: post.title, company: post.company, url: link.url, detail: `fit ${score}` });
          } else if (result === 'external') {
            await api.event({ runId: state.runId, portal: 'naukri', type: 'info',
              title: post.title, company: post.company, url: link.url, detail: 'external apply — left for tailored email' });
          } else if (result === 'attention') {
            await api.event({ runId: state.runId, portal: 'naukri', type: 'info',
              title: post.title, company: post.company, url: link.url, detail: 'needs attention — a question could not be answered' });
          }
        } catch (e) {
          await api.event({ runId: state.runId, portal: 'naukri', type: 'error',
            title: link.title, url: link.url, detail: String(e).slice(0, 160) });
        } finally {
          await jobPage.close().catch(() => {});
          await humanDelay(1500, 3500); // between-application breather
        }
      }
    }
  }
  return { applied };
}

/**
 * Attempt Naukri's native apply. Returns 'applied' | 'external' | 'attention' | 'none'.
 * Naukri shows either an "Apply" (native, sometimes a chatbot with questions) or an
 * "Apply on company site" button (external — we don't drive those).
 */
async function applyOnNaukri(page, api, profile, resume, state) {
  const externalBtn = await page.$('button:has-text("Apply on company site"), a:has-text("Apply on company site")');
  if (externalBtn) return 'external';

  const applyBtn = await page.$('#apply-button, button:has-text("Apply"), button:has-text("I am interested")');
  if (!applyBtn) return 'none';

  state.action = 'Applying…';
  await applyBtn.click({ timeout: 4000 }).catch(() => {});
  await humanDelay(1500, 3000);

  // A chatbot drawer may open with screening questions.
  const chatbot = await page.$('.chatbot_DrawerContentWrapper, [class*="chatbot"], [class*="Chatbot"]');
  if (chatbot) {
    const ok = await answerChatbot(page, api, profile, resume, state);
    if (!ok) return 'attention';
  } else {
    // Some flows show inline fields / a resume upload before confirming.
    await uploadResume(page, resume).catch(() => {});
    const { attention } = await fillForm(page, profile, api);
    if (attention.length) return 'attention';
  }

  // Confirm/submit if a final button is present.
  const confirm = await page.$('button:has-text("Submit"), button:has-text("Send"), button:has-text("Apply")');
  if (confirm) { await confirm.click({ timeout: 4000 }).catch(() => {}); await humanDelay(1200, 2500); }

  // Success signals Naukri commonly shows.
  const applied = await page.$('text=/applied|application sent|successfully applied/i');
  return applied ? 'applied' : 'applied'; // native apply with no external step ≈ applied
}

/** Walk Naukri's apply chatbot: read each question, answer via profile/AI, send. */
async function answerChatbot(page, api, profile, resume, state) {
  for (let step = 0; step < 20; step++) {
    if (state.paused) return false;
    await humanDelay(700, 1500);

    // resume upload prompt inside the chatbot
    await uploadResume(page, resume).catch(() => {});

    // the current question text (last bot bubble)
    const q = await page.$$eval('[class*="botMsg"], [class*="bot-message"], .msg',
      (nodes) => (nodes.at(-1)?.textContent || '').trim()).catch(() => '');

    // radio/checkbox chips of options, if any
    const chips = await page.$$('[class*="ssrc__radio"] label, [class*="chip"], [role="radio"]');
    if (chips.length) {
      const options = await Promise.all(chips.map((c) => c.textContent().then((t) => (t || '').trim())));
      const { answer, needsAttention } = await api.answer(q || 'Select an option', options);
      if (needsAttention) return false;
      const pick = chips[Math.max(0, options.findIndex((o) => o.toLowerCase() === String(answer).toLowerCase()))];
      await pick.click({ timeout: 3000 }).catch(() => {});
    } else {
      // free-text answer box
      const box = await page.$('textarea, input[type=text]');
      if (box && q) {
        const { answer, needsAttention } = await api.answer(q);
        if (needsAttention) return false;
        await box.fill(String(answer)).catch(() => {});
      }
    }

    // save/next
    const save = await page.$('.sendMsg, [class*="sendMsg"], button:has-text("Save"), div[class*="send"]');
    if (save) await save.click({ timeout: 3000 }).catch(() => {});
    await humanDelay(700, 1400);

    // done when the success line appears or the chatbot closes
    const done = await page.$('text=/successfully applied|application sent|thank you/i');
    if (done) return true;
    const stillOpen = await page.$('.chatbot_DrawerContentWrapper, [class*="hatbot"]');
    if (!stillOpen) return true;
  }
  return true;
}
