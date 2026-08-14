import { validateAnswer } from './answer-guard.js';
// Generic, portal-agnostic form filler. Matches visible fields to profile answers by
// their labels; anything it can't answer from the profile it routes to the backend's
// AI (/answer), which stays honest — it returns NEEDS_ATTENTION rather than inventing.
import { humanDelay } from './browser.js';
import { logField, logBlank } from './log.js';
import { logEvent } from './logfile.js';

// profile key → label keywords that imply it. Ordered most-specific first (matchKey returns
// the first hit), so e.g. "first name" wins over the generic "name". Covers the common
// LinkedIn/Indeed Easy-Apply screening questions from the profile the backend sends.
const SYNONYMS = {
  first_name: ['first name', 'given name'],
  last_name: ['last name', 'surname', 'family name'],
  full_name: ['full name', 'your name', 'legal name', 'name'],
  email: ['email', 'e-mail'],
  phone: ['phone', 'mobile', 'contact number', 'contact no', 'cell'],
  headline: ['headline', 'professional title'],
  address: ['street address', 'address line', 'address'],
  city: ['city', 'town'],
  state: ['state', 'province', 'region'],
  country: ['country'],
  postal_code: ['pin code', 'pincode', 'zip', 'postal', 'pin'],
  location: ['current location', 'location'],
  current_title: ['current designation', 'job title', 'current title', 'designation', 'current role'],
  current_company: ['current company', 'current employer', 'employer', 'organisation', 'organization'],
  // NOTE: no bare 'experience'/' exp' here. " exp" matched "what is your EXPected ctc?", so
  // every expected-salary question was answered with the years-of-experience value (→ "1").
  years_experience: ['years of experience', 'total experience', 'how many years', 'relevant experience', 'experience in years', 'years exp'],
  experience_level: ['experience level', 'seniority'],
  job_type: ['job type', 'employment type'],
  current_ctc: ['current ctc', 'current salary', 'current compensation', 'present salary'],
  expected_ctc: ['expected ctc', 'expected salary', 'expected compensation', 'desired salary', 'salary expectation'],
  notice_period: ['notice period', 'notice', 'how soon can you join', 'availability to start'],
  available_from: ['start date', 'available from', 'earliest start', 'joining date', 'available to start'],
  work_authorization: ['work authorization', 'work authorisation', 'authorized to work', 'legally authorized', 'work permit', 'right to work', 'visa'],
  requires_sponsorship: ['sponsorship', 'require sponsorship', 'need sponsorship', 'visa sponsorship'],
  willing_to_relocate: ['relocate', 'willing to relocate', 'open to relocation'],
  willing_remote: ['work remote', 'remotely', 'willing to work remote', 'open to remote'],
  willing_onsite: ['onsite', 'on-site', 'on site', 'work from office', 'in office'],
  security_clearance: ['security clearance', 'clearance'],
  phone_country_code: ['country code', 'phone code', 'dial code'],
  highest_education: ['highest education', 'highest qualification', 'education level', 'degree'],
  gpa: ['gpa', 'cgpa', 'grade point', 'percentage'],
  completed_bachelors: ['completed a bachelor', 'bachelor', 'graduated', 'graduation'],
  how_did_you_hear: ['how did you hear', 'how did you find', 'source', 'referral source'],
  veteran_status: ['veteran', 'protected veteran'],
  ethnicity: ['ethnicity', 'race'],
  hispanic_latino: ['hispanic', 'latino', 'latinx'],
  gender: ['gender', 'sex'],
  nationality: ['nationality', 'citizenship'],
  disability_status: ['disability', 'disabled'],
};

function labelFor(el) {
  // best-effort label text near a field
  return el.evaluate((node) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (node.getAttribute('aria-label')) return clean(node.getAttribute('aria-label'));
    if (node.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
      if (lab) return clean(lab.textContent);
    }
    const wrapLabel = node.closest('label');
    if (wrapLabel) return clean(wrapLabel.textContent);
    if (node.placeholder) return clean(node.placeholder);
    if (node.name) return clean(node.name);
    // nearest preceding text
    let p = node.parentElement, hops = 0;
    while (p && hops++ < 3) {
      const t = clean(p.querySelector('label, .label, legend, h3, h4, span')?.textContent);
      if (t) return t;
      p = p.parentElement;
    }
    return '';
  });
}

// A question that lists its own choices — "current work mode: 1.remote 2.hybrid 3.onsite" or
// "asset pickup: 1.mumbai 2.bangalore 3.chennai". These must NOT be keyword-matched: a word
// inside the options ("onsite", "location") would map the whole question to a profile field
// and fill the wrong value ("Yes", the profile city). They go to the backend, which reads the
// embedded options and chooses one of them.
function hasEmbeddedOptions(label) {
  return (label.match(/\d\s*[.)]\s*[a-z]/gi) || []).length >= 2;
}

// A text input that autocompletes from a dropdown (LinkedIn's City field, react-select inputs…).
// These need a suggestion PICKED, not just text typed, or the form treats them as empty.
async function isTypeahead(el) {
  return el.evaluate((n) => {
    if (n.tagName !== 'INPUT') return false;
    const ac = (n.getAttribute('aria-autocomplete') || '').toLowerCase();
    return n.getAttribute('role') === 'combobox' || ac === 'list' || ac === 'both'
      || !!n.getAttribute('aria-controls') || !!n.getAttribute('aria-owns')
      || (n.getAttribute('autocomplete') === 'off' && n.hasAttribute('aria-expanded'));
  }).catch(() => false);
}

/**
 * Text that sits where a label goes but asks nothing.
 *
 * A file input mid-upload renders "Uploading…" as its nearest text, and labelFor() walks up to
 * three ancestors looking for exactly that. It was then treated as a screening question,
 * routed to the model, and — with no possible answer — recorded as unanswered and used to
 * pause the application. Five Indeed applications stalled on a progress indicator.
 */
const NOT_A_QUESTION = /^(uploading|loading|please wait|processing|saving|uploaded|attaching)|^\s*[.…]+\s*$/i;

export function isRealQuestion(label) {
  const l = String(label || '').replace(/\s+/g, ' ').trim();
  if (l.length < 2) return false;
  return !NOT_A_QUESTION.test(l);
}

function matchKey(label) {
  if (hasEmbeddedOptions(label)) return null;
  for (const [key, words] of Object.entries(SYNONYMS)) {
    if (words.some((w) => label.includes(w))) return key;
  }
  return null;
}

/**
 * Fill the visible text/select fields of the current form. Returns {filled, attention}
 * where attention lists questions the profile couldn't answer honestly.
 */
/**
 * Answer radio groups and tick consent checkboxes.
 *
 * Easy Apply's screening questions ("Are you authorised to work in X?", "How many years of
 * Java?") are overwhelmingly RADIO groups, and fillForm skips radios/checkboxes outright. So
 * they stayed blank, LinkedIn refused to advance the step, no Submit button ever appeared and
 * the application was abandoned — which is exactly the "hundreds relevant, zero applied"
 * pattern. Returns the questions we genuinely couldn't answer.
 */
export async function fillChoices(page, api, root) {
  const attention = [];

  // Read every visible, unanswered radio group with its question + option labels in one pass.
  // `root`, when given, is the Easy-Apply modal — scope EVERYTHING to it. Without this the scan
  // reaches the whole page and starts "answering" LinkedIn's own search header ("search by
  // title…", "city, state, or zip code"), which never advances the modal. The modal is the
  // form; the page around it is not.
  const scanIn = (rootEl) => {
    const scope = rootEl || document;
    const out = [];
    const seen = new Set();
    const txt = (s) => (s || '').replace(/\s+/g, ' ').trim();
    scope.querySelectorAll('input[type=radio]').forEach((el) => {
      if (!el.name || seen.has(el.name) || el.offsetParent === null) return;
      seen.add(el.name);
      const radios = [...scope.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)];
      const labelOf = (r) => {
        const l = r.labels && r.labels[0];
        if (l) return txt(l.textContent);
        const wrap = r.closest('label');
        return txt(wrap ? wrap.textContent : r.value);
      };
      // The question: a fieldset legend if present, else the first line of the surrounding
      // form-element block (LinkedIn wraps each question in its own container).
      const fs = el.closest('fieldset');
      let q = fs && fs.querySelector('legend') ? txt(fs.querySelector('legend').textContent) : '';
      if (!q) {
        const box = el.closest('[data-test-form-element], .fb-dash-form-element, .jobs-easy-apply-form-element') || el.parentElement;
        q = box ? txt((box.innerText || '').split('\n').find((s) => s.trim().length > 3)) : '';
      }
      out.push({ name: el.name, question: q, options: radios.map(labelOf), answered: radios.some((r) => r.checked) });
    });
    return out;
  };
  // ElementHandle.evaluate passes the element as the first arg; Page.evaluate passes nothing —
  // so scanIn(undefined) falls back to `document`. One function, both scopes.
  const groups = await (root ? root.evaluate(scanIn) : page.evaluate(scanIn)).catch(() => []);

  for (const g of groups) {
    if (g.answered || !g.options.length) continue;
    const question = g.question || g.options.join(' / ');
    let pick = null;
    try {
      const ans = await api.answer(question, g.options);
      if (!ans.needsAttention && ans.answer) pick = String(ans.answer).trim();
    } catch { /* fall through to attention */ }
    if (!pick) {
      logBlank(question, 'no answer yet', api.portal || '');
      attention.push(question);
      await api.recordQuestion(question, '').catch(() => {});
      continue;
    }
    // Map the model's answer back onto a real option (exact → contains → first word).
    const low = pick.toLowerCase();
    let idx = g.options.findIndex((o) => o.toLowerCase() === low);
    if (idx < 0) idx = g.options.findIndex((o) => o.toLowerCase().includes(low) || low.includes(o.toLowerCase()));
    if (idx < 0) idx = g.options.findIndex((o) => o.toLowerCase().startsWith(low.split(/\s+/)[0]));
    if (idx < 0) {
      logBlank(question, 'no answer yet', api.portal || '');
      attention.push(question);
      await api.recordQuestion(question, '').catch(() => {});
      continue;
    }
    logField(question, g.options[idx]);
    // Save the screening question + the answer used, so it's reviewable/editable in Autofill.
    await api.recordQuestion(question, g.options[idx]).catch(() => {});
    const radios = await (root || page).$$(`input[type=radio][name="${g.name.replace(/"/g, '\\"')}"]`);
    if (radios[idx]) {
      await radios[idx].check({ timeout: 2500 }).catch(async () => {
        await radios[idx].click({ force: true, timeout: 2500 }).catch(() => {});
      });
      await humanDelay(200, 550);
    }
  }

  // Consent / acknowledgement checkboxes block submission until ticked.
  const boxes = await (root || page).$$('input[type=checkbox]:visible');
  for (const b of boxes) {
    try {
      if (await b.isChecked()) continue;
      const label = (await labelFor(b)) || '';
      if (/agree|consent|terms|acknowledg|certify|confirm|privacy|declare/i.test(label)) {
        await b.check({ timeout: 2000 }).catch(() => {});
        await humanDelay(150, 400);
      }
    } catch { /* skip */ }
  }
  return { attention };
}

export async function fillForm(page, profile, api, root) {
  const filled = [];
  const attention = [];
  // Scope to the modal when given. Filling `page` reaches LinkedIn's search header — the
  // "search by title, skill, or company" / "city, state, or zip code" boxes that kept getting
  // typed into while the modal's own fields stayed empty and it never advanced.
  const inputs = await (root || page).$$('input:visible, textarea:visible, select:visible');

  for (const el of inputs) {
    try {
      const type = (await el.getAttribute('type')) || (await el.evaluate((n) => n.tagName.toLowerCase()));
      if (['hidden', 'file', 'submit', 'button', 'checkbox', 'radio'].includes(type)) continue;
      const current = await el.inputValue().catch(() => '');
      if (current && current.trim()) continue; // don't clobber prefilled values

      const label = await labelFor(el);
      if (!label || !isRealQuestion(label)) continue;
      const key = matchKey(label);
      const tag = await el.evaluate((n) => n.tagName.toLowerCase());
      // A field with no direct profile mapping is a custom SCREENING question — those are the
      // ones worth saving to Autofill answers (not "First name" / "Email").
      const isScreening = !key;

      let value = key ? profile[key] : null;

      // no direct profile match → ask the backend AI, honestly
      if (!value) {
        let options = null;
        if (tag === 'select') {
          options = await el.$$eval('option', (os) => os.map((o) => o.textContent.trim()).filter(Boolean));
        }
        const ans = await api.answer(label, options);
        if (ans.needsAttention || !ans.answer) {
          // Only a REQUIRED blank should abandon the application. Treating every optional
          // field we couldn't answer as a blocker threw away applications that would have
          // submitted perfectly well with that box left empty.
          const required = await el.evaluate((n) =>
            n.required || n.getAttribute('aria-required') === 'true').catch(() => false);
          // The BACKEND's reason, not a generic one. "no option fit the profile", "not
          // supported by profile" and "AI off" are three different problems needing three
          // different fixes, and all three read as "no answer yet" — which is how one question
          // blocked eight Indeed applications with nothing recorded about why.
          logBlank(label, ans.reason ? `no answer — ${ans.reason}` : 'no answer yet', api.portal || '');
          if (required) attention.push(label);
          // Save it so the owner can keep an answer in Profile → Autofill answers.
          await api.recordQuestion(label, '').catch(() => {});
          continue;
        }
        value = ans.answer;
        // SAVE IT NOW, so the next job answers this question without asking again.
        //
        // A successful answer was never recorded — only failures were. So every job re-asked
        // the model the same screening questions ("how many years of Java?", "notice period")
        // and paid for it every time, which is most of an AI budget spent re-deriving answers
        // already known. Two jobs in a row asking the same thing should cost one call, not two.
        //
        // Stored as "auto" and listed in Autofill answers for review: the owner sees what was
        // answered on their behalf and can correct it, and a corrected answer wins from then on.
        // Awaited rather than fired and forgotten, so the very next job in this same run sees
        // it — that is the difference between "eventually" and "immediately", and it is what
        // was asked for.
        if (!ans.fromSaved) {
          await api.recordQuestion(label, String(value)).catch(() => { /* telemetry, never fatal */ });
        }
      }
      if (!value) continue;

      // LAST CHECK BEFORE IT REACHES THE EMPLOYER.
      //
      // Everything above decides WHAT to answer; this decides whether the answer is safe to
      // submit. A run typed 800000 — the owner's expected annual package in rupees — into
      // "What is your expected hourly rate in USD?". The lookup was not wrong: the value was
      // right for the question it was stored against and catastrophic for the one being asked.
      //
      // Fails closed on purpose. A refusal costs one paused application the owner finishes in
      // the dashboard; a wrong figure is already in front of a hiring manager and cannot be
      // withdrawn. The question is saved either way, so answering it once fixes it for good.
      const safety = validateAnswer(label, value, { currency: profile.salaryCurrency || 'INR' });
      if (!safety.ok) {
        // Through logBlank so it lands in the LOG FILE too, in full and with its reason —
        // the terminal truncates a long question to fit its column, which loses the very
        // wording needed to answer it. Same path for LinkedIn and Indeed.
        logBlank(label, `not submitted: ${safety.reason}`, api.portal || '');
        await api.recordQuestion(label, '').catch(() => {});
        const required = await el.evaluate((n) =>
          n.required || n.getAttribute('aria-required') === 'true').catch(() => false);
        if (required) attention.push(label);
        continue;
      }

      if (tag === 'select') {
        // Pick the CLOSEST option, not an exact-label match: "Male" must still select an option
        // labelled "Male " or "male", "1" must land in a "0-2 years" style bucket, etc.
        const opts = await el.$$eval('option', (os) => os
          .map((o) => ({ label: (o.textContent || '').replace(/\s+/g, ' ').trim(), value: o.value }))
          .filter((o) => o.label && !/^(select|choose|please|--)/i.test(o.label)));
        const v = String(value).toLowerCase().trim();
        const m = opts.find((o) => o.label.toLowerCase() === v)
          || opts.find((o) => o.label.toLowerCase().includes(v) || v.includes(o.label.toLowerCase()))
          || opts.find((o) => o.label.toLowerCase().split(/[\s/–-]+/).some((w) => v.split(/[\s/–-]+/).includes(w)));
        if (m) await el.selectOption(m.value).catch(() => el.selectOption({ label: m.label }).catch(() => {}));
      } else if (await isTypeahead(el)) {
        // A typeahead/autocomplete (LinkedIn's "City" field is one): typing raw text shows a
        // dropdown but leaves the field WITHOUT a committed value, so the form refuses to
        // advance — that is why every "location (city)" job paused. Type it, wait for the
        // suggestions, then pick the first one so a real value is selected.
        await el.click({ timeout: 2000 }).catch(() => {});
        await el.fill('').catch(() => {});
        await el.type(String(value), { delay: 45 }).catch(() => {});
        await humanDelay(800, 1300);
        await el.press('ArrowDown').catch(() => {});
        await humanDelay(150, 350);
        await el.press('Enter').catch(() => {});
      } else {
        await el.click({ timeout: 2000 }).catch(() => {});
        await el.fill(String(value)).catch(() => {});
      }
      logField(label, String(value).replace(/\s+/g, ' ').slice(0, 70));
      // Screening questions (with the answer used) go to Autofill answers for review/override.
      if (isScreening) await api.recordQuestion(label, String(value)).catch(() => {});
      filled.push(label);
      await humanDelay(250, 700);
    } catch { /* skip a stubborn field, keep going */ }
  }
  return { filled, attention };
}

/**
 * Fill CUSTOM dropdowns — the button/div widgets (LinkedIn & Indeed react-select style) that
 * are NOT a native <select>, so fillForm never sees them. For each one: read its label, OPEN it
 * to reveal the real options, ask the backend to pick the closest to the profile, then CLICK
 * that option. This is what makes a question with no text field get answered from its dropdown.
 */
export async function fillDropdowns(page, profile, api, root) {
  const scope = root || page;
  const attention = [];
  const triggers = await scope.$$(
    '[role="combobox"]:visible, [aria-haspopup="listbox"]:visible, '
    + '[class*="select__control" i]:visible, [data-automation-id*="dropdown" i]:visible, '
    + '[data-automation-id*="select" i]:visible').catch(() => []);

  for (const t of triggers) {
    try {
      const tag = await t.evaluate((n) => n.tagName.toLowerCase());
      if (tag === 'select' || tag === 'input' || tag === 'textarea') continue; // native handled elsewhere
      // Already shows a chosen value? ("Select…"/"Choose"/a placeholder don't count.)
      const cur = (await t.evaluate((n) => (n.innerText || '').replace(/\s+/g, ' ').trim())).toLowerCase();
      if (cur && cur.length < 40 && !/select|choose|please|^-+$|^—$/.test(cur)) continue;

      const label = await labelFor(t);
      if (!label || !isRealQuestion(label)) continue;

      await t.click({ timeout: 2500 }).catch(() => {});
      await humanDelay(500, 1000);
      const opts = await page.$$eval(
        '[role="option"], [role="listbox"] li, [class*="select__option" i], [class*="menu" i] [role="option"]',
        (els) => [...new Set(els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
          .filter((s) => s && s.length < 80))]).catch(() => []);
      if (opts.length < 1) { await page.keyboard.press('Escape').catch(() => {}); continue; }

      // Closest option: profile value first, else let the backend choose from the REAL options.
      const key = matchKey(label);
      let want = key ? profile[key] : null;
      const near = (val) => {
        if (!val) return null;
        const v = String(val).toLowerCase().trim();
        return opts.find((o) => o.toLowerCase() === v)
          || opts.find((o) => o.toLowerCase().includes(v) || v.includes(o.toLowerCase()))
          || opts.find((o) => o.toLowerCase().split(/[\s/–-]+/).some((w) => v.split(/[\s/–-]+/).includes(w)));
      };
      let choice = near(want);
      if (!choice) {
        const ans = await api.answer(label, opts).catch(() => ({}));
        if (ans && ans.answer) choice = near(ans.answer);
      }
      if (!choice) {
        await page.keyboard.press('Escape').catch(() => {});
        logBlank(label);
        await api.recordQuestion(label, '').catch(() => {});
        const req = await t.evaluate((n) => n.getAttribute('aria-required') === 'true' || !!n.closest('[required]')).catch(() => false);
        if (req) attention.push(label);
        continue;
      }

      // Click the option whose text is our choice.
      const safe = choice.replace(/["\\]/g, '');
      const optEl = await page.$(`[role="option"]:has-text("${safe}"), [class*="select__option" i]:has-text("${safe}"), [role="listbox"] li:has-text("${safe}")`);
      if (optEl) await optEl.click({ timeout: 2500 }).catch(() => {});
      else await page.keyboard.press('Escape').catch(() => {});
      logField(label, choice);
      await api.recordQuestion(label, choice).catch(() => {});
      await humanDelay(300, 700);
    } catch { /* skip a stubborn dropdown, keep going */ }
  }
  return { attention };
}

/**
 * Read which resume the PORTAL has selected. Never uploads one.
 *
 * JobPilot has no business attaching a file here. LinkedIn and Indeed each already hold the
 * member's resume and arrive at the apply step with it selected — that is the file the employer
 * is meant to receive. Pushing our own copy in was solving a problem neither portal has.
 *
 * It also broke applying outright. The upload was asynchronous, so the code had to wait for the
 * portal to echo OUR filename back; when the portal showed its own saved resume instead — which
 * is the normal case — the echo never came, the upload was declared unconfirmed, and the
 * application was held for review. Job after job paused on "the resume did not finish uploading"
 * while the correct resume sat attached on screen. The guard meant to prevent a CV-less
 * application became the reason nothing was submitted at all.
 *
 * So this observes and does not act: find the name of whatever the portal has attached, record
 * it so the run can be checked afterwards, and return. It reports; it never blocks. A missing
 * name is noted and the application proceeds, because the portal — not JobPilot — decides what
 * it sends, and it will refuse its own form if it truly has no resume.
 *
 * Returns { attached, name }.
 */
export async function observeResume(page, root) {
  const scope = root || page;
  const found = await scope.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    // Filenames only. Anchored to a document extension so a company called "Acme Inc." or a
    // sentence ending in ".pdf support" cannot be mistaken for the attachment.
    const FILE = /([\w][\w \-&().]{0,80}\.(?:pdf|docx?|rtf))\b/i;

    // 1. The portal's own filename element. LinkedIn renders the selected resume in a card whose
    //    class carries "file-name"; Indeed's markup is similar. Most reliable when present,
    //    because it is the portal stating its choice rather than us inferring it from prose.
    for (const n of document.querySelectorAll('[class*="file-name" i], [class*="filename" i]')) {
      const t = clean(n.innerText || n.textContent);
      if (t && t.length < 120) return { name: t, how: 'filename-element' };
    }

    // 2. A CHECKED resume option. Both portals list saved resumes as radios once there is more
    //    than one, and only the checked one is actually sent — reading the first label instead
    //    would confidently report the wrong file, which is worse than reporting none.
    for (const r of document.querySelectorAll('input[type=radio]:checked, input[type=checkbox]:checked')) {
      const box = r.closest('label, li, [class*="option" i], [class*="card" i], div');
      const m = clean(box && box.innerText).match(FILE);
      if (m) return { name: m[1].trim(), how: 'checked-option' };
    }

    // 3. Any document filename visible in the apply form.
    const body = clean(document.body && document.body.innerText);
    const m = body.match(FILE);
    if (m) return { name: m[1].trim(), how: 'form-text' };

    // 4. The portal's built-in resume, which is a profile rather than a file and so has no
    //    filename at all. Still a real attachment — reporting "none" here would be wrong.
    if (/indeed resume/i.test(body)) return { name: 'Indeed Resume', how: 'built-in' };
    if (/linkedin profile/i.test(body) && /resume|cv\b/i.test(body)) {
      return { name: 'LinkedIn profile', how: 'built-in' };
    }
    return null;
  }).catch(() => null);

  if (found && found.name) {
    console.log(`     ✓ resume attached by the portal: ${found.name}`);
    logEvent('resume', { outcome: 'portal-attached', name: found.name, detectedBy: found.how });
    return { attached: true, name: found.name };
  }
  // Not a failure and not a pause — the portal validates its own form. Recorded so that "was a
  // resume ever attached?" is answerable from the log rather than guessed at.
  console.log('     · no resume name visible on this form — the portal decides what it sends');
  logEvent('resume', { outcome: 'none-visible' });
  return { attached: false, name: null };
}
