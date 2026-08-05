// LinkedIn page fixtures.
//
// Built to match the parts of a real job page that have actually caused bugs:
//  · the title rendered TWICE (a visible span plus a visually-hidden screen-reader copy),
//    which is where "Software EngineerSoftware Engineer" came from;
//  · the "Meet the hiring team" and "About the company" panels, which sit in the same pane as
//    the job description and are the prime suspects when the fit gate scores a Java role 0 and
//    reports it as "missing recruitment, HR, onboarding";
//  · reposts of one role under several job ids.

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
  + `<body>${body}</body></html>`;

export const JOB_DESCRIPTION =
  'About the job. We are hiring a Java Backend Developer to design and ship REST APIs with '
  + 'Spring Boot. You will own services end to end: schema design in PostgreSQL, caching with '
  + 'Redis, containerised deploys on Docker and Kubernetes, and CI in GitHub Actions. The '
  + 'frontend is React and TypeScript, and you will work closely with that team. We expect '
  + 'strong fundamentals in data structures, comfort writing unit and integration tests, and '
  + 'the ability to debug production issues. 2+ years of professional Java experience required. '
  + 'Nice to have: Kafka, AWS, and experience with event-driven architectures.';

/**
 * The About-the-company panel as a STAFFING FIRM writes it — long, and entirely about
 * recruitment, HR and onboarding. This is the block that beats the real description on length
 * when `#job-details` goes stale, and it is what a "largest text block" fallback will happily
 * hand to the fit gate. The model then reports the job as needing recruitment/HR/onboarding
 * skills, scores it 0, and the run skips every posting as "stack mismatch (fit 0)".
 */
export const STAFFING_ABOUT = `
  <section class="jobs-company">
    <h2>About the company</h2>
    <p>TalentBridge is a specialist recruitment and staffing partner. Our HR and recruitment
       teams manage the complete hiring lifecycle on behalf of our clients: workforce planning,
       sourcing, screening, interview coordination, offer negotiation, background verification,
       documentation, onboarding and post-joining engagement. We operate dedicated recruitment
       delivery centres and our HR operations team handles payroll, compliance, statutory
       filings, benefits administration and employee relations for the contractors we place.
       Our onboarding specialists ensure every candidate completes induction, compliance
       training and system provisioning before day one. We have been recognised for excellence
       in recruitment process outsourcing, HR shared services and onboarding experience across
       the region for several consecutive years, and our recruitment consultants maintain
       long-term relationships with both candidates and hiring managers throughout the
       recruitment and onboarding journey.</p>
  </section>`;

/** The recruiter panel. Its language is HR/recruitment — never the job's requirements. */
const HIRING_TEAM = `
  <section class="job-details-people-who-can-help__section">
    <h2>Meet the hiring team</h2>
    <div class="hirer-card__container">
      <a href="/in/priya-r"><span aria-hidden="true">Priya R</span></a>
      <div class="hirer-card__hirer-job-title">Talent Acquisition Specialist</div>
      <p>Priya leads recruitment for engineering roles, manages the HR interview loop and
         handles candidate onboarding. Recruitment, HR operations and onboarding are her focus
         areas, and she has been hiring across the organisation for six years. Message Priya
         about the recruitment process, HR policies, onboarding timelines and referrals.</p>
    </div>
  </section>`;

const ABOUT_COMPANY = `
  <section class="jobs-company">
    <h2>About the company</h2>
    <p>Acme Technologies is a 5,000-person organisation. Our people team invests heavily in
       recruitment, HR operations, onboarding and learning and development, and we have been
       recognised as a great place to work for six consecutive years across every region we
       operate in, from our first office to our newest engineering centres worldwide.</p>
  </section>`;

/**
 * A job page.
 * @param descriptionSelector set to a renamed class to simulate LinkedIn changing its markup,
 *        which forces `readPosting` down its "largest text block" fallback.
 */
export function linkedinJob({
  id = '4001', title = 'Java Backend Developer', company = 'Acme Technologies',
  easyApply = true, description = JOB_DESCRIPTION, descriptionSelector = 'id="job-details"',
  aboutPanel = ABOUT_COMPANY,
} = {}) {
  const applyBtn = easyApply
    ? `<button class="jobs-apply-button" aria-label="Easy Apply to ${title} at ${company}"
         onclick="document.getElementById('ea-modal').style.display='block'">Easy Apply</button>`
    : `<a class="jobs-apply-button" aria-label="Apply on company website"
         href="https://acme.example/careers">Apply</a>`;
  return page(`${title} | ${company} | LinkedIn`, `
    <main>
      <div class="jobs-search__job-details">
        <div class="job-details-jobs-unified-top-card">
          <h1 class="job-details-jobs-unified-top-card__job-title">
            <span aria-hidden="true">${title}</span><span class="visually-hidden">${title}</span>
          </h1>
          <div class="job-details-jobs-unified-top-card__company-name">${company}</div>
          <div class="job-details-jobs-unified-top-card__primary-description-container">Bengaluru, India</div>
          <span class="job-details-jobs-unified-top-card__job-insight">₹12,00,000 - ₹18,00,000 per year</span>
          <div class="jobs-apply-button--top-card">${applyBtn}</div>
        </div>
        <article ${descriptionSelector}><p>${description}</p></article>
        ${HIRING_TEAM}
        ${aboutPanel}
      </div>
    </main>
    ${easyApplyModal(title)}`);
}

/** The Easy Apply modal: one screening step, then submit. Hidden until the button is clicked. */
function easyApplyModal(title) {
  return `
  <div id="ea-modal" class="jobs-easy-apply-modal" role="dialog" data-test-modal style="display:none">
    <h2>Apply to ${title}</h2>
    <div id="ea-step1">
      <label for="yoe">How many years of work experience do you have with Java?</label>
      <input id="yoe" name="yoe" type="text" required aria-required="true">
      <button aria-label="Continue to next step"
        onclick="document.getElementById('ea-step1').style.display='none';
                 document.getElementById('ea-step2').style.display='block';">Next</button>
    </div>
    <div id="ea-step2" style="display:none">
      <button aria-label="Submit application"
        onclick="document.getElementById('ea-modal').innerHTML='<h2>Your application was sent</h2>';">Submit</button>
    </div>
  </div>`;
}

/**
 * A search-results page. `repostsOf` duplicates one role under extra job ids, which is what
 * made a single posting appear ~20 times in one run.
 */
export function linkedinSearch({ count = 3, startId = 4001, repostsOf = 0 } = {}) {
  const card = (id, title, company) => `
    <li data-occludable-job-id="${id}">
      <div class="job-card-container" data-job-id="${id}">
        <a class="job-card-container__link job-card-list__title--link" href="/jobs/view/${id}/">
          <span aria-hidden="true">${title}</span><span class="visually-hidden">${title}</span>
        </a>
        <div class="artdeco-entity-lockup__subtitle">${company}</div>
      </div>
    </li>`;
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(card(startId + i, `Java Backend Developer ${i}`, 'Acme Technologies'));
  }
  // Reposts: same title AND company, different ids — must collapse to one.
  for (let i = 0; i < repostsOf; i++) {
    rows.push(card(9000 + i, 'Full-stack app developer', 'Kefilo'));
  }
  return page('Jobs | LinkedIn', `<main><ul class="jobs-search-results__list">${rows.join('')}</ul></main>`);
}

/** LinkedIn's signed-out wall. */
export function authwall() {
  return page('Sign In | LinkedIn',
    '<main><h1>Sign in to LinkedIn</h1><p>Join now to see this job.</p></main>');
}
