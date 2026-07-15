// Generic, portal-agnostic form filler. Matches visible fields to profile answers by
// their labels; anything it can't answer from the profile it routes to the backend's
// AI (/answer), which stays honest — it returns NEEDS_ATTENTION rather than inventing.
import { humanDelay } from './browser.js';

// profile key → label keywords that imply it
const SYNONYMS = {
  full_name: ['full name', 'your name', 'name'],
  first_name: ['first name', 'given name'],
  last_name: ['last name', 'surname', 'family name'],
  email: ['email', 'e-mail'],
  phone: ['phone', 'mobile', 'contact number', 'contact no'],
  location: ['current location', 'location', 'city'],
  city: ['city', 'town'],
  state: ['state', 'province'],
  country: ['country'],
  postal_code: ['pin', 'zip', 'postal'],
  current_title: ['current designation', 'job title', 'designation', 'current role'],
  current_company: ['current company', 'employer', 'organisation', 'organization'],
  years_experience: ['total experience', 'years of experience', 'experience', 'exp'],
  current_ctc: ['current ctc', 'current salary'],
  expected_ctc: ['expected ctc', 'expected salary'],
  notice_period: ['notice period', 'notice'],
  work_authorization: ['work authorization', 'work permit', 'visa'],
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

function matchKey(label) {
  for (const [key, words] of Object.entries(SYNONYMS)) {
    if (words.some((w) => label.includes(w))) return key;
  }
  return null;
}

/**
 * Fill the visible text/select fields of the current form. Returns {filled, attention}
 * where attention lists questions the profile couldn't answer honestly.
 */
export async function fillForm(page, profile, api) {
  const filled = [];
  const attention = [];
  const inputs = await page.$$('input:visible, textarea:visible, select:visible');

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

      let value = key ? profile[key] : null;

      // no direct profile match → ask the backend AI, honestly
      if (!value) {
        let options = null;
        if (tag === 'select') {
          options = await el.$$eval('option', (os) => os.map((o) => o.textContent.trim()).filter(Boolean));
        }
        const ans = await api.answer(label, options);
        if (ans.needsAttention || !ans.answer) { attention.push(label); continue; }
        value = ans.answer;
      }
      if (!value) continue;

      if (tag === 'select') {
        await el.selectOption({ label: value }).catch(async () => {
          await el.selectOption(value).catch(() => {});
        });
      } else {
        await el.click({ timeout: 2000 }).catch(() => {});
        await el.fill(String(value)).catch(() => {});
      }
      filled.push(label);
      await humanDelay(250, 700);
    } catch { /* skip a stubborn field, keep going */ }
  }
  return { filled, attention };
}

/** Attach the resume PDF (base64 from the backend) to a file input, if the form has one. */
export async function uploadResume(page, resume) {
  if (!resume || !resume.hasResume) return false;
  const input = await page.$('input[type=file]');
  if (!input) return false;
  const buffer = Buffer.from(resume.contentBase64, 'base64');
  await input.setInputFiles({
    name: resume.filename || 'resume.pdf',
    mimeType: 'application/pdf',
    buffer,
  }).catch(() => {});
  return true;
}
