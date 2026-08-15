// Page fixtures for the portal harness.
//
// These are deliberately built from what the REAL pages contain, including the parts that
// have nothing to do with jobs — most importantly Cloudflare's telemetry config blob, which
// is present on ordinary served pages and literally contains the word "captcha". A fixture
// that omits it is a fixture that cannot reproduce the bug it exists to catch.

/**
 * Cloudflare's RUM config, injected into every page it fronts — challenge or not. Verified
 * against a live in.indeed.com response. The `"captcha":{...}` key here is the reason a
 * substring test for "captcha" reports a perfectly good search page as a captcha wall.
 */
export const CLOUDFLARE_TELEMETRY = `<script>
window.__CF$cv$params={r:'8f2a',t:'MTcwMA=='};
window.__CF_RUM__={"events":{"4xx":{"jsv-ping":true,"first-interaction":true,"challenge-loaded":true,"click":true,"page-unload":true},"5xx":{"jsv-ping":true,"first-interaction":true,"challenge-loaded":true,"click":true,"page-unload":true},"captcha":{"jsv-ping":true,"first-interaction":true,"challenge-loaded":true,"click":true,"page-unload":true},"under_attack":{"jsv-ping":true,"first-interaction":true,"challenge-loaded":true,"click":true,"page-unload":true}}};
</script>`;

const page = (title, body, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head>`
  + `<body>${body}${CLOUDFLARE_TELEMETRY}</body></html>`;

/**
 * reCAPTCHA v3's invisible iframe. Indeed runs v3 site-wide to score traffic silently, so this
 * is present on ORDINARY pages — 0×0, no challenge, nothing for a human to solve. A detector
 * that matches `iframe[src*="recaptcha"]` reports every healthy search page as a captcha wall.
 */
export const INVISIBLE_RECAPTCHA_V3 =
  '<div class="grecaptcha-badge" style="width:0;height:0;overflow:hidden">'
  + '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=abc" width="0" height="0"'
  + ' style="width:0;height:0;border:0" title="reCAPTCHA"></iframe></div>';

/** An ordinary Indeed search-results page carrying `count` job cards. */
export function indeedSearch({ count = 15, startKey = 0, query = 'java developer' } = {}) {
  const cards = Array.from({ length: count }, (_, i) => {
    const jk = `jk${String(startKey + i).padStart(6, '0')}`;
    return `<div class="job_seen_beacon" data-jk="${jk}">
      <h2 class="jobTitle"><a href="/rc/clk?jk=${jk}&amp;fccid=abc">Java Developer ${startKey + i}</a></h2>
      <span data-testid="company-name">Acme ${startKey + i}</span>
    </div>`;
  }).join('\n');
  return page(
    `${query} Jobs (with Salaries) | Indeed.com`,
    // The invisible v3 badge rides along on real pages, so it rides along here.
    `<div id="mosaic-jobResults"><ul>${cards || '<li>No jobs found</li>'}</ul></div>`
    + INVISIBLE_RECAPTCHA_V3,
  );
}

/** An Indeed job page. `apply: 'indeed' | 'external' | 'none'` picks which button it offers. */
export function indeedJob({ jk = 'jk000000', title = 'Java Developer', company = 'Acme',
                            apply = 'indeed', description, applyWindow = false } = {}) {
  const desc = description ?? (
    'We are looking for a Java backend developer to build and maintain REST APIs using '
    + 'Spring Boot, PostgreSQL and Docker. You will work with React on the frontend, write '
    + 'unit tests, and participate in code reviews. Experience with AWS is a plus. This is a '
    + 'full-time position based in our Bengaluru office with hybrid working.');
  // The real Apply button navigates into the smartapply flow. A fixture whose button does
  // nothing would make every job look like it needed manual attention — a harness that differs
  // from the real page produces confident, wrong results.
  // `window.open`, not `location.href`.
  //
  // Real Indeed opens the application in a SEPARATE WINDOW. This fixture navigated the same
  // page, so the adapter's new-window handling was never exercised by any test — and that is
  // precisely where it failed in production: it raced a 6s timeout for the new page, missed it,
  // and spent twelve steps driving the search page while the real application sat in a window
  // beside it. A harness that differs from the real page produces confident, wrong results, and
  // this is the exact case that rule exists for.
  //
  // `applyWindow: false` keeps the old same-page shape, because Indeed serves both.
  const button = apply === 'indeed'
    ? (applyWindow
      ? `<button id="indeedApplyButton" class="ia-IndeedApplyButton"
           onclick="window.open('/smartapply?jk=${jk}&step=1', '_blank')">Apply now</button>`
      : `<button id="indeedApplyButton" class="ia-IndeedApplyButton"
           onclick="location.href='/smartapply?jk=${jk}&step=1'">Apply now</button>`)
    : apply === 'external'
      ? '<a role="button" href="https://acme.example/careers">Apply on company site</a>'
      : '<button>Save this job</button>';
  return page(`${title} - ${company} | Indeed.com`, `
    <h1 class="jobsearch-JobInfoHeader-title">${title}</h1>
    <div data-testid="inlineHeader-companyName">${company}</div>
    <div data-testid="inlineHeader-companyLocation">Bengaluru, Karnataka</div>
    <div id="salaryInfoAndJobType"><span class="attribute_snippet">₹8,00,000 - ₹12,00,000 a year</span></div>
    <div id="viewJobButtonLinkContainer">${button}</div>
    <div id="jobDescriptionText">${desc}</div>` + INVISIBLE_RECAPTCHA_V3);
}

/**
 * The Indeed Apply flow. Each step navigates to the next, as the real one does — a Continue
 * button that doesn't move the page would let a broken step-loop pass.
 *  step 1 → a screening question, Continue
 *  step 2 → Submit application
 *  step 3 → the confirmation the adapter looks for
 */
export function indeedApplyStep({ step = 1, jk = 'jk000000' } = {}) {
  if (step >= 4) {
    return page('Application submitted - Indeed',
      '<h1>Your application has been submitted</h1>');
  }
  if (step === 1) {
    return page('Apply - Indeed', `
      <form>
        <label for="phone">Phone number</label><input id="phone" name="phone" type="tel">
        <button type="button" onclick="location.href='/smartapply?jk=${jk}&step=2'">Continue</button>
      </form>`);
  }
  // THE RESUME STEP — the screen photographed sitting open and untouched while the adapter
  // drove the search page. Indeed already holds the resume and offers it selected; there is
  // nothing to upload, only a Continue to press. If the adapter ever tries to upload here, the
  // file input below will hold a file and the test says so.
  if (step === 2) {
    return page('Add or update your resume - Indeed', `
      <h1>Add or update your resume</h1>
      <div class="resume-card">
        <input type="radio" name="resume" id="saved" checked>
        <label for="saved">Suhas_Resume.pdf</label>
        <span class="file-name">Suhas_Resume.pdf</span>
      </div>
      <input type="file" id="upload" style="width:1px;height:1px">
      <button type="button" onclick="location.href='/smartapply?jk=${jk}&step=3'">Continue</button>`);
  }
  return page('Apply - Indeed', `
    <form onsubmit="location.href='/smartapply?jk=${jk}&step=4';return false;">
      <button type="submit">Submit application</button>
    </form>`);
}

/** A genuine Cloudflare interstitial — what a REAL block looks like. */
export function cloudflareChallenge() {
  return page('Just a moment...', `
    <div id="challenge-form">
      <h1>Verify you are human</h1>
      <p>www.indeed.com needs to review the security of your connection before proceeding.</p>
      <div class="h-captcha" data-sitekey="abc"></div>
    </div>`);
}

/** Indeed's own "blocked" page. */
export function indeedBlocked() {
  return page('blocked - indeed.com',
    '<h1>Additional Verification Required</h1><p>Please solve the CAPTCHA below to continue.</p>'
    + '<iframe title="reCAPTCHA challenge" src="https://www.google.com/recaptcha/api2/anchor"></iframe>');
}
