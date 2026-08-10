// LinkedIn connection outreach — the "network your way in" flow, worker side.
//
//   1) sendConnectionRequests: find recruiters/hiring folks for your roles and send a
//      connection request with a short, AI-optimized note (your default template).
//   2) checkAcceptances: revisit the people you invited; when one has ACCEPTED (you're now
//      1st-degree), mark them connected and draft the follow-up (auto-approved when your
//      template + Auto-message are on).
//   3) sendApprovedMessages: send those approved messages as LinkedIn DMs with your résumé
//      attached, then mark them sent.
//
// Everything is bounded (caps + time + human delays) and defensive: LinkedIn changes its
// DOM often, so a selector miss skips that one item instead of breaking the run. Nothing is
// invented and nothing sends unless your template/toggle allow it (the backend enforces that).
import { humanDelay } from '../browser.js';
import { fault } from '../fault.js';
import { shouldContact, claimOutreach } from '../gate.js';

const NOTE_LIMIT = 300;

// Include the target CITY in the query. Without it LinkedIn returned recruiters worldwide
// (US/EU names that can't be connected to or messaged from here) — 35 people found, 0 usable.
// "<role> recruiter <city>" keeps the results in the market you're actually applying to.
function peopleSearchUrl(keyword, location) {
  const loc = location && location.toLowerCase() !== 'remote' ? ` ${location}` : ' India';
  const p = new URLSearchParams({
    keywords: `${keyword} recruiter${loc}`,
    origin: 'GLOBAL_SEARCH_HEADER',
    network: '["S","O"]',   // 2nd-degree + out-of-network: the ones you CAN still invite
  });
  return `https://www.linkedin.com/search/results/people/?${p.toString()}`;
}

/** True if LinkedIn is showing a login/authwall — caller should stop quietly. */
function loggedOut(page) {
  return /\/login|\/authwall|signup/i.test(page.url());
}

/**
 * Pull the people results (name, profile URL, headline).
 *
 * Anchored on the PROFILE LINKS themselves (a[href*="/in/"]), not on result-card class names.
 * The old selectors (reusable-search__result-container / entity-result) are LinkedIn's previous
 * search DOM — they now match nothing, which is why every keyword reported "0 people found"
 * even though the page was full of recruiters. A /in/ link is what a person result IS, so this
 * survives the class renames.
 */
/**
 * Exported for tests only. The people search is the one place the connections wall gets its
 * evidence, and a whole run rejecting ~300 people traced to one wrong split in here — so it
 * needs coverage that does not require driving LinkedIn.
 */
export async function collectPeople(page) {
  return page.$$eval('a[href*="/in/"]', (links) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    const seen = new Set();
    // Only links inside the RESULTS list. Taking every /in/ link on the page also swept up
    // "People also viewed", the feed rail and the footer — profiles that were never search
    // results, which is why so many had no Connect and no Message button at all.
    const inResults = (a) => !!a.closest('main, [role="main"], .search-results-container, ul.reusable-search__entity-result-list');
    for (const a of links) {
      const href = (a.href || '').split('?')[0];
      if (!/\/in\/[^/]+\/?$/.test(href) || seen.has(href)) continue;
      if (!inResults(a)) continue;
      // Walk up to the row/card that holds this link so we can read the headline near it.
      let box = a;
      for (let i = 0; i < 5 && box.parentElement; i++) {
        box = box.parentElement;
        if (box.matches('li, [data-view-name], .artdeco-list__item, div[componentkey]')) break;
      }
      // Splitting on a newline is not enough: live LinkedIn renders the whole thing on ONE
      // line — "Karthick M • 2nd Technical Recruiter at Acme" — so the connection degree and
      // the headline came through as part of the name and the note opened "Hi Karthick M •
      // 2nd,". Cut at the bullet, then drop any trailing degree marker.
      const name = clean(a.getAttribute('aria-label') || a.innerText)
        .split('\n')[0]
        .split('•')[0]
        .replace(/\s*\b\d(?:st|nd|rd|th)\+?\b\s*$/i, '')
        .trim();
      if (!name || /LinkedIn Member/i.test(name) || name.length > 60) continue;
      const boxText = clean(box.innerText);
      // The headline is usually the line after the name inside the same card.
      const after = boxText.split(name).slice(1).join(name);
      // The headline follows the bullet, it does not precede it.
      //
      // A live card reads "Karthick M • 2nd Technical Recruiter at Acme", so `after` is
      // " • 2nd Technical Recruiter at Acme" and taking split('•')[0] returned the empty
      // string before the bullet — EVERY time. With no headline, shouldContact finds no
      // recruiter title, has no posts to fall back on, and refuses: a whole run rejected all
      // ~300 people with "no recruiter title and no posts to judge", including profiles
      // literally titled "techrecruiter" and "HR". The wall was not being strict; it was
      // being fed nothing.
      // Take the first segment that is actually a HEADLINE, not LinkedIn's social proof.
      //
      // A run sent "is a mutual connection" as the headline for 147 people, "are mutual
      // connections" for 43 more and variants for another 67 — roughly 257 of ~700. Their real
      // headline sat elsewhere in the card, so shouldContact found no recruiter title, had no
      // posts to fall back on, and refused them: 688 rejected as "no recruiter title and no
      // posts to judge", while genuine recruiters ("IT Recruiter @Coretek Labs") came through
      // perfectly. Taking everything after the first bullet was too blunt — on a card that
      // shows mutual connections, that segment IS the social proof.
      //
      // So walk the segments and skip what is demonstrably not a headline: the connection
      // degree, mutual-connection blurbs, follower counts, and the action buttons. Whatever
      // survives is the person's own description of themselves.
      const NOISE = /^(\d(?:st|nd|rd|th)\+?)$|mutual connection|^\d[\d,.]*[km]? (followers?|connections?)$|^(follow|connect|message|view profile)$/i;
      const segments = clean(after)
        .split(/[•\n]/)
        .map((x) => clean(x).replace(/^\s*\d(?:st|nd|rd|th)\+?\s*/i, '').trim())
        .filter((x) => x.length > 2 && !NOISE.test(x));
      const headline = (segments[0] || '').slice(0, 140);
      seen.add(href);
      out.push({ name, profileUrl: href, headline });
    }
    return out;
  }).catch(() => []);
}

/**
 * The person's own recent posts, read from their profile's activity section.
 *
 * This is the evidence for "are they actually hiring?" — a headline that doesn't say recruiter
 * can still belong to an engineer who posted "my team is hiring, DM me". Returns up to 3 posts;
 * an empty list simply means we have nothing to judge on, and the caller treats that as no.
 */
async function readRecentPosts(page) {
  return page.$$eval(
    '.feed-shared-update-v2, [data-urn*="activity"], .occludable-update, .pv-recent-activity-item',
    (nodes) => nodes.slice(0, 3)
      .map((n) => (n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 700))
      .filter((t) => t.length > 40),
  ).catch(() => []);
}

/** Print what a search page actually contains when it yields nothing. */
async function describePeoplePage(page) {
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title.slice(0, 80),
    profileLinks: document.querySelectorAll('a[href*="/in/"]').length,
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  })).catch(() => null);
  if (!info) return;
  console.log(`     [diag] ${info.url}`);
  console.log(`     [diag] title: ${info.title} · /in/ links on page: ${info.profileLinks}`);
  console.log(`     [diag] text: ${info.text}`);
}

/**
 * On a person's card or profile, click Connect (revealing it via "More" if needed), then
 * "Add a note", fill the note, and send. Returns true only if the invite was sent.
 */
/**
 * Why is there no Connect button?
 *
 * Investigated live with the worker's own session: every profile showed Follow but no Connect
 * and no Message. That looks like a broken selector and is not one — the Sent invitations page
 * showed **155 invitations still pending**, far past the ~100/week LinkedIn allows. Once an
 * account is over that line LinkedIn simply stops rendering the invite control, on every
 * profile, and leaves Follow in its place.
 *
 * Which means the connections flow was not failing. It was working well enough to exhaust the
 * account's invitation capacity, and then had no way to say so.
 *
 * Three causes look identical in a log — capped account, stale selector, degraded page — and
 * they need three different fixes, so this prints the evidence once per run and names the
 * capped case explicitly when it sees Follow-without-Connect.
 */
let profileDiagShown = false;
async function reportProfileNotRendering(page) {
  if (profileDiagShown) return;
  profileDiagShown = true;
  const info = await page.evaluate(() => {
    const c = (x) => (x || '').replace(/\s+/g, ' ').trim();
    const main = document.querySelector('main, [role="main"]') || document.body;
    return {
      url: location.href.slice(0, 90),
      h1: c(main.querySelector('h1')?.innerText).slice(0, 60),
      buttons: main.querySelectorAll('button, [role="button"]').length,
      labels: [...main.querySelectorAll('button, [role="button"]')]
        .map((b) => c(b.getAttribute('aria-label') || b.innerText)).filter(Boolean).slice(0, 8),
      bodyLen: (document.body?.innerText || '').length,
    };
  }).catch(() => null);
  if (!info) { console.log('     [diag] the profile page could not be read at all'); return; }
  fault('PROFILE_NO_CONTROLS', { url: page.url() });
  console.log('     what the page actually is:');
  console.log(`     [diag] ${info.url}`);
  console.log(`     [diag] h1: "${info.h1}"  ·  buttons: ${info.buttons}  ·  body: ${info.bodyLen} chars`);
  console.log(`     [diag] controls: ${info.labels.join(' | ') || '(none)'}`);
  // Follow present but Connect absent, on profile after profile, is not a selector fault and
  // not a coincidence: it is LinkedIn withholding the invite control from a capped account.
  // Confirmed on this account — the Sent invitations page showed 155 still pending, well past
  // the ~100/week LinkedIn allows, and every profile had dropped to Follow-only.
  const followOnly = info.labels.some((l) => /^follow/i.test(l))
    && !info.labels.some((l) => /connect/i.test(l));
  if (followOnly) {
    console.log('     ✋ This profile offers Follow but no Connect — and that is usually YOUR');
    console.log('        account, not this person. LinkedIn withdraws the invite control once');
    console.log('        too many invitations are outstanding (~100/week, pending ones count).');
    console.log('        Fix: linkedin.com/mynetwork/invitation-manager/sent/ → withdraw the old');
    console.log('        ones, and lower the connections budget in Schedule so it rebuilds slowly.');
  } else if (!info.h1 && info.bodyLen < 4000) {
    console.log('     [diag] an empty h1 with a thin body means LinkedIn served a degraded');
    console.log('            profile view — the selectors are not the problem.');
  }
}

/**
 * Follow, when Connect is unavailable.
 *
 * A capped account still gets Follow on every profile, and following a recruiter puts you in
 * their feed at zero cost to invitation capacity. It is strictly worse than connecting, and
 * strictly better than the previous behaviour, which was to give up on that person entirely
 * and move on with nothing recorded.
 */
async function followPerson(page, scope) {
  const root = scope || page;
  const handles = await root.$$('button, [role="button"], a[role="button"]').catch(() => []);
  for (const h of handles) {
    const label = await h.evaluate((n) => (
      (n.getAttribute('aria-label') || '') + ' ' + (n.innerText || '')
    ).replace(/\s+/g, ' ').trim().toLowerCase()).catch(() => '');
    // "Follow" only — never "Following" (already done) or "Unfollow".
    if (/^follow/.test(label) && !/unfollow|following/.test(label)) {
      if (await h.isVisible().catch(() => false)) {
        await h.click({ timeout: 3000 }).catch(() => {});
        await humanDelay(700, 1300);
        return true;
      }
    }
  }
  return false;
}

async function inviteWithNote(page, scope, note) {
  const root = scope || page;
  // Find Connect by what the button SAYS, not by a class/aria pattern. On a real profile the
  // control is variously aria-label="Invite Jane Doe to connect", plain text "Connect", or
  // hidden behind "More" — and the previous narrow selector matched none of them, which is why
  // every single person came back "no Connect available".
  const findConnect = async () => {
    const handles = await root.$$('button, [role="button"], div[role="button"] , a[role="button"]');
    for (const h of handles) {
      const label = await h.evaluate((n) => (
        (n.getAttribute('aria-label') || '') + ' ' + (n.innerText || '')
      ).replace(/\s+/g, ' ').trim().toLowerCase()).catch(() => '');
      if (!label) continue;
      if (/\bconnect\b/.test(label) && !/message|follow|more|pending|connected/.test(label)) {
        if (await h.isVisible().catch(() => false)) return h;
      }
    }
    return null;
  };

  let connect = await findConnect();
  if (!connect) {
    // Connect is often tucked into the "More" overflow on 2nd/3rd-degree profiles.
    const more = await root.$('button[aria-label*="More actions"], button[aria-label="More"], button:has-text("More")');
    if (more) {
      await more.click({ timeout: 3000 }).catch(() => {});
      await humanDelay(600, 1100);
      connect = await findConnect();
    }
  }
  if (!connect) {
    // "No Connect button" has two very different causes and the log used to show neither:
    // the person genuinely can't be invited, or the profile never rendered. Say which.
    await reportProfileNotRendering(root === page ? page : page).catch(() => {});
    return false; // already connected / follow-only / can't invite → caller may DM
  }

  await connect.click({ timeout: 3000 }).catch(() => {});
  await humanDelay(900, 1600);

  const addNote = await page.$('button[aria-label="Add a note"]');
  if (addNote) {
    await addNote.click({ timeout: 3000 }).catch(() => {});
    await humanDelay(500, 1000);
    const box = await page.$('#custom-message, textarea[name="message"], textarea[id*="custom-message"]');
    if (box) { await box.fill(note.slice(0, NOTE_LIMIT)).catch(() => {}); await humanDelay(400, 900); }
  }
  const send = await page.$('button[aria-label="Send now"], button[aria-label="Send invitation"], button:has-text("Send")');
  if (!send) { await dismissDialog(page); return false; }

  // A weekly-invite-limit or email-verification wall means we should stop inviting.
  const blocked = await page.$('text=/weekly invitation limit|verify your email|add.*email/i');
  if (blocked) { await dismissDialog(page); return 'limit'; }

  await send.click({ timeout: 3000 }).catch(() => {});
  await humanDelay(900, 1600);
  return true;
}

async function dismissDialog(page) {
  const x = await page.$('button[aria-label="Dismiss"], button[aria-label="Cancel"]');
  if (x) await x.click({ timeout: 2000 }).catch(() => {});
}

/**
 * On an already-open PROFILE page: open Message, attach the résumé, type the body, and Send.
 * Returns true only if actually sent. Used for accepted-invite follow-ups AND for people who
 * are directly messageable (already 1st-degree / Open Profile / a hiring-post author) so we can
 * reach them WITHOUT a connection request.
 */
async function composeMessage(page, resume, body) {
  // A message with no words is worse than no message at all — a bare résumé landing in a
  // recruiter's inbox reads as a bot. Every path below refuses to press Send unless the text
  // is actually IN the box.
  const text = (body || '').trim();
  if (!text) {
    fault('MESSAGE_NOT_SENT', { reason: 'no message text was generated' });
    return false;
  }

  const msgBtn = await page.$('button[aria-label*="Message"], a[aria-label*="Message"]');
  if (!msgBtn) return false;
  await msgBtn.click({ timeout: 3000 }).catch(() => {});
  await humanDelay(1400, 2400);

  // Type FIRST, attach after. The attachment upload re-renders the compose form on LinkedIn,
  // which can blur the box and swallow everything typed afterwards.
  const box = await page.$('.msg-form__contenteditable, div[role="textbox"][contenteditable="true"]');
  if (!box) return false;
  await box.click({ timeout: 2000 }).catch(() => {});
  await page.keyboard.type(text, { delay: 15 }).catch(() => {});
  await humanDelay(400, 800);

  // Read it back. A click that missed, a lost focus, or a swallowed keystroke all look
  // identical from here otherwise — and previously Send fired regardless.
  const typed = await box.evaluate((el) => (el.innerText || el.textContent || '').trim()).catch(() => '');
  if (!typed || typed.length < Math.min(12, text.length)) {
    fault('MESSAGE_NOT_SENT', { reason: 'text did not reach the box', got: typed.length, wanted: text.length });
    return false;
  }

  if (resume && resume.hasResume) {
    const fileInput = await page.$('.msg-form__attachment-container input[type="file"], form.msg-form input[type="file"], input[type="file"]');
    if (fileInput) {
      await fileInput.setInputFiles({
        name: resume.filename || 'resume.pdf', mimeType: 'application/pdf',
        buffer: Buffer.from(resume.contentBase64, 'base64'),
      }).catch(() => {});
      await humanDelay(1200, 2200);
      // The upload can wipe the draft. If it did, the résumé would go out alone — put the
      // text back, and if that fails, send nothing.
      const still = await box.evaluate((el) => (el.innerText || el.textContent || '').trim()).catch(() => '');
      if (!still) {
        await box.click({ timeout: 2000 }).catch(() => {});
        await page.keyboard.type(text, { delay: 15 }).catch(() => {});
        const again = await box.evaluate((el) => (el.innerText || el.textContent || '').trim()).catch(() => '');
        if (!again) {
          fault('MESSAGE_NOT_SENT', { reason: 'the attachment cleared the typed message' });
          return false;
        }
      }
    }
  }

  const send = await page.$('button.msg-form__send-button, button[type="submit"]:has-text("Send")');
  if (!send) return false;
  await send.click({ timeout: 3000 }).catch(() => {});
  await humanDelay(1200, 2200);
  return true;
}

/** Phase 1 — send fresh connection requests to recruiters for the user's roles. */
export async function sendConnectionRequests(page, api, plan, state, resume) {
  // Uncapped: keep inviting for the rest of the block. LinkedIn's own weekly invite limit is
  // still respected — inviteWithNote returns 'limit' and we stop gracefully when it's hit.
  const cap = plan.connectCap || 1000;
  const deadline = Date.now() + (plan.blockMinutes || 120) * 60_000;
  let sent = 0, skipped = 0, rejected = 0, throttled = 0;
  let peopleDiagShown = false;
  console.log('\n  🤝 Connections — verifying each person, then inviting the ones who hire…');

  // Widen the net: every role × every target city, so the pool is large AND local.
  const cities = (plan.locations && plan.locations.length ? plan.locations : ['India']);
  const searches = [];
  for (const keyword of (plan.keywords || [])) for (const city of cities) searches.push([keyword, city]);
  for (const [keyword, city] of searches) {
    if (state.stopped || state.paused || sent >= cap || Date.now() > deadline) break;
    state.action = `Finding recruiters for "${keyword}" in ${city}`;
    await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: state.action });
    await page.goto(peopleSearchUrl(keyword, city), { waitUntil: 'domcontentloaded' }).catch(() => {});
    await humanDelay(2200, 3600);
    if (loggedOut(page)) { fault('SESSION_EXPIRED', { portal: 'linkedin', where: 'people search' }); return sent; }

    const people = await collectPeople(page);
    console.log(`     "${keyword} recruiter · ${city}" → ${people.length} people found`);
    if (people.length === 0 && !peopleDiagShown) { peopleDiagShown = true; await describePeoplePage(page).catch(() => {}); }
    for (const person of people) {
      if (state.stopped || state.paused || sent >= cap || Date.now() > deadline) break;
      try {
        // GATE 1 — the headline, before we spend a page load on them. This is what was missing:
        // every result was invited or messaged regardless of who they were.
        const quick = await shouldContact(api, person, plan, []);
        if (!quick.ok && !quick.topic && /not a hiring role|no recruiter title/i.test(quick.reason)) {
          rejected++;
          console.log(`     ✗ ${person.name} — ${quick.reason}`);
          continue;
        }

        const company = person.headline.split(/ at | @ /i)[1]?.trim() || '';
        // Send the invite from the person's profile page (stable place for the Connect button).
        await page.goto(person.profileUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await humanDelay(1500, 2600);
        if (loggedOut(page)) return sent;

        // GATE 2 — the ambiguous middle: read what they've actually posted and ask whether it
        // is about hiring. No hiring signal in the headline AND none in the posts ⇒ no contact.
        let verdict = quick;
        if (!quick.ok) {
          const posts = await readRecentPosts(page).catch(() => []);
          verdict = await shouldContact(api, person, plan, posts);
          if (!verdict.ok) {
            rejected++;
            console.log(`     ✗ ${person.name} — ${verdict.reason}`);
            await humanDelay(1200, 2200);
            continue;
          }
        }

        // Anti-spam + duplicate guard, immediately before we send anything. This both checks
        // and records, so a retry cannot double-message someone.
        const claim = await claimOutreach(api, {
          company, role: keyword, recruiterUrl: person.profileUrl,
          recruiterName: person.name, resumeVersion: resume?.filename || '',
        });
        if (!claim.ok) {
          throttled++;
          console.log(`     ⊘ ${person.name} — ${claim.reason}`);
          continue;
        }

        const { id } = await api.upsertContact({
          portal: 'linkedin', name: person.name, profileUrl: person.profileUrl,
          company, role: person.headline,
        }).catch(() => ({}));
        if (!id) { skipped++; continue; }

        // The note references what they posted about, when we know it — the difference between
        // "I am interested" and a message that proves we read their post.
        const { note } = await api.connectionNote(id, verdict.topic || '').catch(() => ({ note: '' }));
        // No note means the message generator failed. Sending anyway would put a bare résumé
        // in front of a recruiter, so skip this person and try again next run.
        if (!note || !note.trim()) {
          skipped++;
          console.log(`     ⚠ ${person.name} — could not build a message, skipping (not sending an empty one)`);
          continue;
        }

        // RUNG 1 — A DIRECT MESSAGE, tried FIRST.
        //
        // This used to be the fallback for people with no Connect button. That ordering was
        // backwards on two counts. A message reaches the recruiter today; an invitation reaches
        // them only if they accept, which most never do — and every invitation spends capacity
        // from LinkedIn's weekly allowance, while a message spends none.
        //
        // That allowance is not theoretical here: the account is sitting on 155 pending
        // invitations, the cleanup withdraws nothing under 21 days old, and LinkedIn restricts
        // the invite control long before the queue clears. Under those conditions the connection
        // route is the one that cannot run, and it was being tried first on every person.
        //
        // composeMessage returns false when there is no Message button — an ordinary profile
        // with closed messaging — so nothing is lost by asking it first; that person simply
        // falls through to the invitation below, exactly as before.
        const dm = await composeMessage(page, resume, note || '').catch(() => false);
        if (dm) {
          sent++;
          console.log(`     ✉ messaged ${person.name} directly (no invitation needed)`);
          await api.setConnectionStatus(id, { status: 'connected', runId: state.runId }).catch(() => {});
          await api.event({ runId: state.runId, portal: 'linkedin', type: 'message_sent',
            title: `Messaged ${person.name}`, url: person.profileUrl, detail: 'direct message with résumé' });
          await humanDelay(2000, 4000);
          continue;
        }

        // RUNG 2 — an invitation with a note, for everyone messaging could not reach.
        const result = await inviteWithNote(page, null, note || '');
        if (result === 'limit') {
          fault('INVITE_LIMIT', { sentThisRun: sent });
          await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
            detail: 'LinkedIn weekly invite limit reached — pausing connection requests.' });
          return sent;
        }
        if (result === true) {
          sent++;
          console.log(`     + invited ${person.name}${company ? ` · ${company}` : ''}`);
          await api.setConnectionStatus(id, { status: 'connection_sent', runId: state.runId, note }).catch(() => {});
        } else {
          {
            // RUNG 3 — Follow. A capped account still gets Follow on every profile, and it
            // costs no invitation capacity. Strictly worse than connecting, strictly better
            // than dropping the person with nothing recorded, which is what used to happen to
            // EVERY recruiter once the account went over its invite limit.
            const followed = await followPerson(page, null).catch(() => false);
            if (followed) {
              console.log(`     ↳ followed ${person.name} (no Connect available — capacity or their settings)`);
              await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
                title: `Followed ${person.name}`, url: person.profileUrl,
                detail: 'no Connect available — followed instead, so they stay reachable' }).catch(() => {});
              // Keep the contact so a later run can invite them once capacity returns.
              await api.setConnectionStatus(id, { status: 'pending', runId: state.runId }).catch(() => {});
            } else {
              skipped++;
              console.log(`     · skipped ${person.name} (no Connect, Message or Follow)`);
            }
          }
        }
      } catch (e) {
        skipped++;
        await api.event({ runId: state.runId, portal: 'linkedin', type: 'error', detail: `invite: ${String(e).slice(0, 120)}` });
      }
      await humanDelay(2500, 4500);
    }
  }
  console.log(`     connections: ${sent} contacted · ${rejected} not hiring · ${throttled} already contacted / rate-limited · ${skipped} unreachable`);
  if (sent > 0) await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: `sent ${sent} connection request(s)` });
  if (rejected > 0) await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
    detail: `${rejected} profile(s) rejected — not recruiters and not posting about hiring` });
  return sent;
}

/** Phase 2 — revisit invited people; when accepted, mark connected + draft the follow-up. */
export async function checkAcceptances(page, api, state) {
  const pending = await api.pendingConnections().catch(() => []);
  let accepted = 0;
  console.log(`\n  ✅ Follow-ups — ${pending.length} invite(s) awaiting acceptance…`);
  for (const c of pending.slice(0, 12)) {
    if (state.stopped || state.paused || !c.profileUrl) continue;
    try {
      await page.goto(c.profileUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await humanDelay(1500, 2600);
      if (loggedOut(page)) return accepted;

      // Still shows a "Pending" invite → not accepted yet. A "Message" button with no
      // "Pending"/"Connect" affordance means we're 1st-degree now (accepted).
      const stillPending = await page.$('button[aria-label*="Pending"], span:has-text("Pending")');
      if (stillPending) continue;
      const canMessage = await page.$('button[aria-label*="Message"], a[aria-label*="Message"]');
      if (!canMessage) continue;

      await api.setConnectionStatus(c.id, { status: 'connected' }).catch(() => {});
      // NOTE: deliberately no draftMessage here any more.
      //
      // This used to draft a 'connection_followup', which sendApprovedMessages then sent — and
      // sendFollowUps ALSO saw the contact as due for touch 1, because accepting leaves
      // followUpStage=0 with no lastContactAt. The person got two messages minutes apart in the
      // same block, and the cadence's stage never advanced because the approved-message path
      // didn't report a touch. The staged cadence is now the single owner of post-acceptance
      // messaging: sendFollowUps sends touch 1 and records it.
      accepted++;
    } catch { /* skip this one */ }
    await humanDelay(1500, 3000);
  }
  if (accepted > 0) await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: `${accepted} connection(s) accepted — messaging them` });
  return accepted;
}

/**
 * Phase 4 — the staged follow-up sequence (Day 1 → 2 → 5 → 10, then archive).
 *
 * A single message after the connection was accepted threw away most of the value of making
 * the connection: most replies come from the second or third touch. The backend decides who is
 * due and writes the body for THAT stage, so message 3 doesn't repeat message 1, and it archives
 * the contact once the sequence is spent — nobody is nudged forever.
 */
export async function sendFollowUps(page, api, resume, state, plan = {}) {
  const deadline = Date.now() + (plan.blockMinutes || 120) * 60_000;
  const due = await api.followUps(15).catch(() => []);
  if (due.length === 0) { console.log('\n  📨 Follow-ups — none due today.'); return 0; }

  console.log(`\n  📨 Follow-ups — ${due.length} due (Day 1 → 2 → 5 → 10, then archived)…`);
  let sent = 0;
  for (const f of due) {
    if (state.stopped || state.paused || Date.now() > deadline) break;
    if (!f.profileUrl || !f.body) continue;
    try {
      await page.goto(f.profileUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await humanDelay(1500, 2600);
      if (loggedOut(page)) return sent;

      // Only the FIRST follow-up carries the résumé; re-attaching it every time reads as
      // automated, and they already have it.
      const withResume = f.stage === 0 ? resume : null;
      if (!(await composeMessage(page, withResume, f.body))) {
        console.log(`     · ${f.name} — no message box (they may have disconnected)`);
        continue;
      }
      // Only advance the stage once the message actually went out, so a failure retries the
      // same touch tomorrow instead of silently skipping it.
      const r = await api.followUpSent(f.contactId).catch(() => ({ ok: false }));
      sent++;
      console.log(`     + ${f.name} — ${f.label}${r.archived ? ' (sequence complete, archived)' : ''}`);
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'message_sent',
        title: `Follow-up to ${f.name || 'a connection'}`, url: f.profileUrl,
        detail: `${f.label}${f.company ? ` · ${f.company}` : ''}` });
    } catch (e) {
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'error',
        detail: `follow-up: ${String(e).slice(0, 120)}` });
    }
    await humanDelay(2500, 4500);
  }
  console.log(`     follow-ups: ${sent} sent`);
  return sent;
}

/** Phase 3 — send approved follow-up messages as DMs with the résumé attached. */
export async function sendApprovedMessages(page, api, resume, state) {
  const msgs = await api.approvedMessages().catch(() => []);
  let done = 0;
  console.log(`\n  💬 Messages — ${msgs.length} approved follow-up(s) to send (résumé attached)…`);
  for (const m of msgs) {
    if (state.stopped || state.paused) break;
    if ((m.portal && m.portal !== 'linkedin') || !m.profileUrl) continue;
    try {
      await page.goto(m.profileUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await humanDelay(1500, 2600);
      if (loggedOut(page)) return done;

      if (!(await composeMessage(page, resume, m.body || ''))) continue;
      await api.markSent(m.id).catch(() => {});
      // Count this as a touch on the cadence too. A message you approved by hand is still a
      // message they received — without this the cadence would send its own touch on top,
      // and keep counting from a stage that no longer reflects reality.
      if (m.contactId) await api.followUpSent(m.contactId).catch(() => {});
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'message_sent',
        title: `Messaged ${m.name || 'a connection'}`, url: m.profileUrl, detail: 'sent with résumé attached' });
      done++;
      console.log(`     + messaged ${m.name || 'a connection'}`);
    } catch (e) {
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'error', detail: `message: ${String(e).slice(0, 120)}` });
    }
    await humanDelay(2000, 3500);
  }
  console.log(`     messages: ${done} sent`);
  return done;
}
