import { Link } from 'react-router-dom';
import { Icon, Logo } from '../components/Icon';
import { CompanyLogo } from '../components/CompanyLogo';
import { FitScale, MiniFit } from '../components/FitScale';
import { DOWNLOADS, RELEASE_BASE } from '../components/DownloadDesktop';

/**
 * The public home page — what a visitor who isn't signed in sees at "/".
 *
 * Every claim here is something JobPilot actually does today: no user counts, no ratings, no
 * testimonials. The product fragments are labelled as examples, built from the real components
 * (FitScale, CompanyLogo) so the page can't drift from the product it describes.
 *
 * Structure follows the agreed reference (docs/UI_SPEC.md → Ashby): one heavy headline, "Log in"
 * as a text link beside ONE filled button, a flat row of source logos, then large white cards.
 */

const RUN = [
  { co: 'Adobe', url: 'https://careers.adobe.com/', t: 'Software Development Engineer', s: 'Bengaluru · careers.adobe.com', fit: 82, st: 'Applied', tone: 'applied' },
  { co: 'Cognizant', url: 'https://careers.cognizant.com/', t: 'Developer, SQL & JavaScript', s: 'Hyderabad · LinkedIn', fit: 74, st: 'Applied', tone: 'applied' },
  { co: 'Freshworks', url: 'https://careers.freshworks.com/', t: 'Java Developer', s: 'Chennai · Indeed', fit: 68, st: 'Needs an answer', tone: 'interviewing' },
  { co: 'Razorpay', url: 'https://razorpay.com/jobs/', t: 'Backend Engineer II', s: 'Remote · Greenhouse', fit: 38, st: 'Skipped', tone: 'interested' },
  { co: 'Zoho', url: 'https://careers.zohocorp.com/', t: 'Member Technical Staff', s: 'Chennai · careers.zohocorp.com', fit: 61, st: 'Queued', tone: 'interested' },
];
const SOURCES = [
  { name: 'LinkedIn', url: 'https://linkedin.com' }, { name: 'Indeed', url: 'https://indeed.com' },
  { name: 'Naukri', url: 'https://naukri.com' }, { name: 'Greenhouse', url: 'https://greenhouse.io' },
  { name: 'Lever', url: 'https://lever.co' }, { name: 'Workday', url: 'https://workday.com' },
  { name: 'Ashby', url: 'https://ashbyhq.com' },
];
const FAQ = [
  { q: 'Does it apply to jobs without asking me?', a: 'Only after you press Resume, and only up to the daily limit you set. You can pause it at any time from the dashboard or the desktop app.' },
  { q: 'Do I have to give JobPilot my LinkedIn password?', a: 'No. You sign in to LinkedIn and Indeed yourself, in the desktop app\'s own browser window. JobPilot uses that session and never sees or stores your password.' },
  { q: 'How is the match score worked out?', a: 'It compares the skills, experience and location in the posting with your profile. Hover any score to see which skills matched and what\'s missing.' },
  { q: 'What happens when a form asks something my profile doesn\'t cover?', a: 'That question is saved for you instead of guessed. Answer it once and every later form that asks the same thing is filled in.' },
  { q: 'Where is my data kept?', a: 'Your profile and tracker are stored in your account. Documents in the vault are encrypted, and downloading one asks for your password again.' },
];

export function HomePage() {
  return (
    <div className="lp">
      <div className="lp-in">
        <header className="lp-nav">
          <Link to="/" className="brand" aria-label="JobPilot home"><Logo size={28} /><span className="brand-name">JobPilot</span></Link>
          <nav className="lp-links" aria-label="Sections">
            <a href="#how">How it works</a><a href="#features">Features</a><a href="#desktop">Desktop app</a><a href="#faq">FAQ</a>
          </nav>
          <span className="lp-sp" />
          <Link className="lp-login" to="/login">Log in</Link>
          <Link className="btn btn-primary" to="/register">Get started</Link>
        </header>

        <section className="lp-hero">
          <div>
            <span className="eyebrow"><span className="eyebrow-tag">New</span>Desktop app for Windows, macOS &amp; Linux</span>
            <h1 className="lp-h1">Apply to the jobs that fit. <span>Skip the ones that don't.</span></h1>
            <p className="lp-lead">JobPilot reads every posting against <b>your résumé</b>, scores the fit, fills in the
              application with your details, and <b>tells you why</b> it applied. All of it lands in one tracker.</p>
            <div className="lp-cta">
              <Link className="btn btn-lg btn-primary" to="/register">Create free account <Icon name="chevron" size={15} /></Link>
              <Link className="btn btn-lg" to="/login">Log in</Link>
            </div>
            <div className="lp-fine">
              <span><Icon name="shield" size={14} />Runs on your own computer</span>
              <span><Icon name="pause" size={12} />Nothing is sent until you press Resume</span>
            </div>
          </div>

          <div className="hero-stack">
            <div className="app-win" aria-label="Example of a run">
              <div className="aw-top"><span className="aw-t">Today's run</span><span className="aw-example">Example</span>
                <span className="live"><span className="live-dot" />Running · 14 of 40</span></div>
              <div className="aw-prog"><i /></div>
              {RUN.map((r) => (
                <div key={r.co} className="aw-row">
                  <CompanyLogo company={r.co} url={r.url} size={32} radius={8} />
                  <div className="aw-id"><div className="aw-tt">{r.t}</div><div className="aw-ss">{r.co} · {r.s}</div></div>
                  <div className="aw-right"><MiniFit score={r.fit} /><span className="aw-st"><span className={`dot ${r.tone}`} />{r.st}</span></div>
                </div>
              ))}
            </div>
            <div className="hero-why">
              <div className="hero-why-h"><b>Why Adobe scored 82</b><span>Great fit</span></div>
              <ul>
                <li><Icon name="check" size={13} />Java, Spring Boot and SQL match your résumé</li>
                <li><Icon name="check" size={13} />Asks 2–4 years; you have 3</li>
                <li className="no"><Icon name="x" size={13} />Kubernetes isn't on your profile</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="lp-logos" aria-label="Job sources">
          <p>Finds openings on the job boards and career sites you already use</p>
          <div className="logo-row">
            {SOURCES.map((s) => (
              <span key={s.name} className="src"><CompanyLogo company={s.name} url={s.url} size={24} radius={6} />{s.name}</span>
            ))}
          </div>
        </section>

        <section className="lp-sec" id="how">
          <div className="lp-sec-h"><div className="lp-k">How a run works</div>
            <h2>Four steps, from the first search to the reply.</h2>
            <p>Every run follows the same path, and the tracker shows which step each job has reached.</p></div>
          <ol className="hw">
            <li className="hw-step"><div className="hw-n"><b>1</b>Find</div><h3>Collects new openings</h3>
              <p>From the boards you've connected and the career sites you've saved with the extension.</p></li>
            <li className="hw-step"><div className="hw-n"><b>2</b>Score</div><h3>Checks each one against you</h3>
              <p>Skills, experience and location, read from the posting itself.</p>
              <div className="hw-vis"><FitScale score={74} /></div></li>
            <li className="hw-step"><div className="hw-n"><b>3</b>Fill</div><h3>Fills in the application</h3>
              <p>Answers come from your profile. Anything it can't answer is saved for you, not guessed.</p></li>
            <li className="hw-step"><div className="hw-n"><b>4</b>Track</div><h3>Keeps the record</h3>
              <p>What was sent, where and when. A reply moves the job along.</p></li>
          </ol>
        </section>

        <section className="lp-sec" id="features">
          <div className="lp-sec-h"><div className="lp-k">Features</div><h2>Everything a serious job search needs, in one place.</h2></div>
          <div className="bento">
            <div className="tile t-4">
              <h3>A score you can argue with</h3>
              <p>Every number has its reasons next to it: which skills matched, what's missing, how your experience compares.</p>
              <div className="tile-vis tile-fits"><FitScale score={91} /><FitScale score={65} /><FitScale score={44} /><FitScale score={22} /></div>
            </div>
            <div className="tile t-2" id="desktop">
              <h3>Desktop app</h3>
              <p>Runs in the background on your computer, with the browser sessions you already have.</p>
              <div className="tile-vis dl">
                {Object.values(DOWNLOADS).map((d) => (
                  <a key={d.file} href={`${RELEASE_BASE}/${d.file}`}>
                    <span><Icon name="download" size={15} />{d.label.replace('Download for ', '')}</span>
                    <small>{d.file.split('.').pop()}</small>
                  </a>
                ))}
              </div>
            </div>
            <div className="tile t-3">
              <h3>One tracker for every application</h3>
              <p>From the board, the extension or auto apply: everything ends up in the same list.</p>
              <div className="tile-vis kanban">
                {[['Interested', 'st-i'], ['Applied', 'st-a'], ['Interview', 'st-v'], ['Offer', 'st-o']].map(([h, c]) => (
                  <div key={h} className={`kcol ${c}`}><div className="kcol-h">{h}</div><div className="kcard" /><div className="kcard kcard-short" /></div>
                ))}
              </div>
            </div>
            <div className="tile t-3">
              <h3>Chrome extension</h3>
              <p>Save a job from any career site in one click, and fill in forms with the answers you've already given.</p>
              <div className="tile-vis"><a className="btn" href="/jobpilot-extension.zip"><Icon name="download" size={15} /> Download the extension</a></div>
            </div>
          </div>
        </section>

        <section className="lp-sec">
          <div className="control">
            <div>
              <div className="lp-k">You stay in control</div>
              <h2>It applies on your behalf, so it only does what you allow.</h2>
              <ul className="checks">
                <li><span className="ci"><Icon name="pause" size={12} /></span><div><b>Starts paused</b><span>A new account never sends anything until you press Resume.</span></div></li>
                <li><span className="ci"><Icon name="gear" size={14} /></span><div><b>A daily limit you set</b><span>It stops at your limit, even if more jobs match.</span></div></li>
                <li><span className="ci"><Icon name="chat" size={14} /></span><div><b>Never guesses an answer</b><span>Questions your profile doesn't cover are saved for you.</span></div></li>
                <li><span className="ci"><Icon name="shield" size={14} /></span><div><b>Your logins stay yours</b><span>You sign in to each site yourself. JobPilot never sees your password.</span></div></li>
              </ul>
            </div>
            <div className="engine-mini" aria-label="Example of the auto apply control">
              <div className="engine-mini-h"><span className="list-ico list-ico-warn"><Icon name="pause" size={14} /></span>
                <div><b>Auto apply is paused</b><div>42 matches waiting · limit 40 a day</div></div></div>
              <div className="engine-mini-r"><span>Daily limit</span><b>40</b></div>
              <div className="engine-mini-r"><span>Unanswered questions</span><span>Skip and save</span></div>
              <Link className="btn btn-lg btn-primary btn-block" to="/register"><Icon name="play" size={13} /> Resume</Link>
            </div>
          </div>
        </section>

        <section className="lp-sec" id="faq">
          <div className="lp-sec-h"><div className="lp-k">FAQ</div><h2>Questions people ask first.</h2></div>
          <div className="faq">
            {FAQ.map((f, i) => (
              <details key={f.q} open={i === 0}>
                <summary>{f.q}<Icon name="chevron" size={16} /></summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="lp-end">
          <div className="lp-end-in">
            <div><h2>Spend your evenings on interviews, not application forms.</h2>
              <p>Free to use · Windows, macOS and Linux · Chrome extension included</p></div>
            <div className="lp-end-acts">
              <Link className="btn btn-lg btn-inv" to="/register">Create free account</Link>
              <Link className="btn btn-lg btn-inv-ghost" to="/login">Log in</Link>
            </div>
          </div>
        </section>

        <footer className="lp-foot">
          <div><Link to="/" className="brand"><Logo size={24} /><span className="brand-name">JobPilot</span></Link>
            <p className="lp-about">Finds the jobs that fit, applies for you, and keeps the record.</p></div>
          <div><h4>Product</h4><ul><li><a href="#how">How it works</a></li><li><a href="#features">Features</a></li><li><a href="#desktop">Desktop app</a></li></ul></div>
          <div><h4>Account</h4><ul><li><Link to="/login">Log in</Link></li><li><Link to="/register">Create account</Link></li></ul></div>
          <div><h4>Help</h4><ul><li><a href="#faq">FAQ</a></li><li><a href="/jobpilot-extension.zip">Chrome extension</a></li></ul></div>
        </footer>
        <div className="lp-legal"><span>© {new Date().getFullYear()} JobPilot</span><span>Made in Bengaluru</span></div>
      </div>
    </div>
  );
}
