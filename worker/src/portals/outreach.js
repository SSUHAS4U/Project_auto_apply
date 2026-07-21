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

const NOTE_LIMIT = 300;

function peopleSearchUrl(keyword) {
  const p = new URLSearchParams({ keywords: `${keyword} recruiter`, origin: 'GLOBAL_SEARCH_HEADER' });
  return `https://www.linkedin.com/search/results/people/?${p.toString()}`;
}

/** True if LinkedIn is showing a login/authwall — caller should stop quietly. */
function loggedOut(page) {
  return /\/login|\/authwall|signup/i.test(page.url());
}

/** Pull the people result cards currently rendered (name, profile URL, headline). */
async function collectPeople(page) {
  return page.$$eval(
    'li.reusable-search__result-container, div.entity-result, li.artdeco-list__item',
    (cards) => cards.map((el) => {
      const link = el.querySelector('a[href*="/in/"]');
      const nameEl = el.querySelector('.entity-result__title-text a span[aria-hidden="true"], span.entity-result__title-text');
      const headline = el.querySelector('.entity-result__primary-subtitle, .entity-result__summary');
      const href = link ? link.href.split('?')[0] : '';
      return {
        name: (nameEl?.textContent || '').replace(/\s+/g, ' ').trim(),
        profileUrl: href,
        headline: (headline?.textContent || '').replace(/\s+/g, ' ').trim(),
      };
    }).filter((p) => p.profileUrl && p.name && !/LinkedIn Member/i.test(p.name)),
  ).catch(() => []);
}

/**
 * On a person's card or profile, click Connect (revealing it via "More" if needed), then
 * "Add a note", fill the note, and send. Returns true only if the invite was sent.
 */
async function inviteWithNote(page, scope, note) {
  const root = scope || page;
  let connect = await root.$('button[aria-label*="Invite"][aria-label*="connect"], button:has-text("Connect")');
  if (!connect) {
    // Some cards hide Connect behind a "More" overflow menu.
    const more = await root.$('button[aria-label*="More actions"], button[aria-label="More"]');
    if (more) {
      await more.click({ timeout: 3000 }).catch(() => {});
      await humanDelay(500, 1000);
      connect = await page.$('div[role="menu"] [aria-label*="connect"], div.artdeco-dropdown__content [role="button"]:has-text("Connect")');
    }
  }
  if (!connect) return false; // already connected / can't invite → skip

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

/** Phase 1 — send fresh connection requests to recruiters for the user's roles. */
export async function sendConnectionRequests(page, api, plan, state) {
  const cap = Math.min(plan.connectCap || 20, 25); // stay well under LinkedIn's weekly limit
  const deadline = Date.now() + Math.min((plan.blockMinutes || 60), 40) * 60_000;
  let sent = 0;

  for (const keyword of (plan.keywords || []).slice(0, 4)) {
    if (state.paused || sent >= cap || Date.now() > deadline) break;
    state.action = `Finding recruiters for "${keyword}"`;
    await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: state.action });
    await page.goto(peopleSearchUrl(keyword), { waitUntil: 'domcontentloaded' }).catch(() => {});
    await humanDelay(2200, 3600);
    if (loggedOut(page)) return sent;

    const people = await collectPeople(page);
    for (const person of people) {
      if (state.paused || sent >= cap || Date.now() > deadline) break;
      try {
        const company = person.headline.split(/ at | @ /i)[1]?.trim() || '';
        const { id } = await api.upsertContact({
          portal: 'linkedin', name: person.name, profileUrl: person.profileUrl,
          company, role: person.headline,
        }).catch(() => ({}));
        if (!id) continue;

        const { note } = await api.connectionNote(id).catch(() => ({ note: '' }));
        // Send the invite from the person's profile page (stable place for the Connect button).
        await page.goto(person.profileUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await humanDelay(1500, 2600);
        if (loggedOut(page)) return sent;

        const result = await inviteWithNote(page, null, note || '');
        if (result === 'limit') {
          await api.event({ runId: state.runId, portal: 'linkedin', type: 'info',
            detail: 'LinkedIn weekly invite limit reached — pausing connection requests.' });
          return sent;
        }
        if (result === true) {
          sent++;
          await api.setConnectionStatus(id, { status: 'connection_sent', runId: state.runId, note }).catch(() => {});
        }
      } catch (e) {
        await api.event({ runId: state.runId, portal: 'linkedin', type: 'error', detail: `invite: ${String(e).slice(0, 120)}` });
      }
      await humanDelay(2500, 4500);
    }
  }
  if (sent > 0) await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: `sent ${sent} connection request(s)` });
  return sent;
}

/** Phase 2 — revisit invited people; when accepted, mark connected + draft the follow-up. */
export async function checkAcceptances(page, api, state) {
  const pending = await api.pendingConnections().catch(() => []);
  let accepted = 0;
  for (const c of pending.slice(0, 12)) {
    if (state.paused || !c.profileUrl) continue;
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
      // Draft the follow-up — auto-approved when the template + Auto-message are on.
      await api.draftMessage({ contactId: c.id, kind: 'connection_followup' }).catch(() => {});
      accepted++;
    } catch { /* skip this one */ }
    await humanDelay(1500, 3000);
  }
  if (accepted > 0) await api.event({ runId: state.runId, portal: 'linkedin', type: 'info', detail: `${accepted} connection(s) accepted — messaging them` });
  return accepted;
}

/** Phase 3 — send approved follow-up messages as DMs with the résumé attached. */
export async function sendApprovedMessages(page, api, resume, state) {
  const msgs = await api.approvedMessages().catch(() => []);
  let done = 0;
  for (const m of msgs) {
    if (state.paused) break;
    if ((m.portal && m.portal !== 'linkedin') || !m.profileUrl) continue;
    try {
      await page.goto(m.profileUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await humanDelay(1500, 2600);
      if (loggedOut(page)) return done;

      const msgBtn = await page.$('button[aria-label*="Message"], a[aria-label*="Message"]');
      if (!msgBtn) continue;
      await msgBtn.click({ timeout: 3000 }).catch(() => {});
      await humanDelay(1400, 2400);

      // Attach the résumé to the open compose box (best-effort — a hidden file input).
      if (resume && resume.hasResume) {
        const fileInput = await page.$('.msg-form__attachment-container input[type="file"], form.msg-form input[type="file"], input[type="file"]');
        if (fileInput) {
          await fileInput.setInputFiles({
            name: resume.filename || 'resume.pdf', mimeType: 'application/pdf',
            buffer: Buffer.from(resume.contentBase64, 'base64'),
          }).catch(() => {});
          await humanDelay(1200, 2200);
        }
      }

      // Type into the contenteditable message box, then send.
      const box = await page.$('.msg-form__contenteditable, div[role="textbox"][contenteditable="true"]');
      if (!box) continue;
      await box.click({ timeout: 2000 }).catch(() => {});
      await page.keyboard.type(m.body || '', { delay: 15 }).catch(() => {});
      await humanDelay(800, 1500);

      const send = await page.$('button.msg-form__send-button, button[type="submit"]:has-text("Send")');
      if (!send) continue;
      await send.click({ timeout: 3000 }).catch(() => {});
      await humanDelay(1200, 2200);

      await api.markSent(m.id).catch(() => {});
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'message_sent',
        title: `Messaged ${m.name || 'a connection'}`, url: m.profileUrl, detail: 'sent with résumé attached' });
      done++;
    } catch (e) {
      await api.event({ runId: state.runId, portal: 'linkedin', type: 'error', detail: `message: ${String(e).slice(0, 120)}` });
    }
    await humanDelay(2000, 3500);
  }
  return done;
}
