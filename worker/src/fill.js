import { isAnswerSafe } from './answer-guard.js';
// Generic, portal-agnostic form filler. Matches visible fields to profile answers by
// their labels; anything it can't answer from the profile it routes to the backend's
// AI (/answer), which stays honest — it returns NEEDS_ATTENTION rather than inventing.
import { humanDelay } from './browser.js';
import { logField, logBlank } from './log.js';

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
      if (!label) continue;
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
          logBlank(label, 'no answer yet', api.portal || '');
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
      const safety = isAnswerSafe(label, value, { currency: profile.salaryCurrency || 'INR' });
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
      if (!label) continue;

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

/** Attach the resume PDF (base64 from the backend) to a file input, if the form has one. */
export async function uploadResume(page, resume, root) {
  if (!resume || !resume.hasResume) return false;
  const input = await (root || page).$('input[type=file]');
  if (!input) return false;
  const buffer = Buffer.from(resume.contentBase64, 'base64');
  await input.setInputFiles({
    name: resume.filename || 'resume.pdf',
    mimeType: 'application/pdf',
    buffer,
  }).catch(() => {});
  return true;
}
