// Generic, portal-agnostic form filler. Matches visible fields to profile answers by
// their labels; anything it can't answer from the profile it routes to the backend's
// AI (/answer), which stays honest — it returns NEEDS_ATTENTION rather than inventing.
import { humanDelay } from './browser.js';

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
  years_experience: ['years of experience', 'total experience', 'how many years', 'relevant experience', 'experience in years', 'years exp', 'experience', ' exp'],
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
        if (ans.needsAttention || !ans.answer) {
          attention.push(label);
          // store it as PENDING so the owner answers it once in Profile → Autofill answers
          await api.recordQuestion(label).catch(() => {});
          continue;
        }
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
