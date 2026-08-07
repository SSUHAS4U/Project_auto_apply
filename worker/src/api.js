// Thin client for the backend's /api/worker/** protocol. Auth is the worker token
// (X-Worker-Token), bound server-side to the owning user. No portal passwords ever
// touch the backend — the browser on this PC holds the real logged-in sessions.

import { logEvent } from './logfile.js';

export class Api {
  /** Monotonic id so a request and its reply can be paired in the log. */
  static seq = 0;

  constructor(baseUrl, token) {
    this.base = baseUrl.replace(/\/$/, '');
    this.token = token;
    // The portal of the block currently running. Set once per block in index.js so calls that
    // need it (recordQuestion) don't have to be threaded through every form-filling helper.
    this.portal = null;
    // Which of the four LinkedIn automations is running. Set by runFlow so every event it
    // emits is attributable, without threading a parameter through every helper.
    this.flow = null;
  }

  /**
   * Every request and every reply goes to the log file.
   *
   * This layer was completely invisible, and it is where the answers were. Five releases were
   * spent arguing about why a run ended, when the truth was one /next reply the worker never
   * recorded. Nothing here is filtered by importance: the whole point is that we stop deciding
   * in advance which line will turn out to matter. Bodies are capped, not sampled, so a big
   * response is shortened but never absent.
   */
  async #req(path, { method = 'GET', body } = {}) {
    const t0 = Date.now();
    const reqId = (++Api.seq).toString(36);
    logEvent('http', { id: reqId, dir: '>', method, path, body: body ?? null });
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: {
          'X-Worker-Token': this.token,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // A network failure never reached any log before. "The backend was unreachable for two
      // minutes" and "the backend said idle" are different bugs that looked identical.
      logEvent('http', { id: reqId, dir: '!', method, path, ms: Date.now() - t0, error: String(e && e.message) });
      throw e;
    }
    const text = await res.text().catch(() => '');
    logEvent('http', {
      id: reqId, dir: '<', method, path, status: res.status, ms: Date.now() - t0,
      body: text.length > 4000 ? text.slice(0, 4000) + `…(+${text.length - 4000} bytes)` : text,
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  hello() { return this.#req('/api/worker/hello'); }
  next() { return this.#req('/api/worker/next'); }
  /**
   * Record something that happened. NEVER throws.
   *
   * Events are telemetry — they feed the dashboard, they don't drive the run. A single failed
   * POST used to reject out of an un-awaited-catch call site and abort the whole block: one
   * 502 while the backend container restarted threw away an hour of applying. Retried once for
   * a transient blip, then given up on silently; the run continues either way.
   */
  async event(e) {
    const body = { flow: this.flow || null, ...e };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.#req('/api/worker/event', { method: 'POST', body });
      } catch (err) {
        if (attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
        this.eventFailures = (this.eventFailures || 0) + 1;
        // Say it once, not 23 times — a backend that is down will fail every event.
        if (this.eventFailures === 1) {
          console.log(`     ⚠ could not record activity (${String(err.message || err).slice(0, 80)}) — the run continues`);
        }
        return {};
      }
    }
    return {};
  }
  runStatus(runId, status, currentAction) {
    return this.#req(`/api/worker/run/${runId}/status`, { method: 'POST', body: { status, currentAction } });
  }
  session(portal, loggedIn, detail) {
    return this.#req('/api/worker/session', { method: 'POST', body: { portal, loggedIn, detail } });
  }
  connectionActions() { return this.#req('/api/worker/connection-actions'); }

  /**
   * Confirm an action actually happened. Until this lands the backend keeps the request
   * queued, so a tick that could not open a window retries instead of losing the click.
   */
  connectionAck(portal, ok, detail) {
    return this.#req('/api/worker/connection-ack', { method: 'POST', body: { portal, ok, detail } });
  }
  evaluate(job) { return this.#req('/api/worker/evaluate', { method: 'POST', body: job }); }
  /** Is this person a recruiter / hiring? { contact, isRecruiter, hiringNow, confidence, topic } */
  verifyPerson(p) { return this.#req('/api/worker/verify-person', { method: 'POST', body: p }); }
  /** Contacts whose next follow-up is due, each with the body written for THAT touch. */
  followUps(limit = 15) { return this.#req(`/api/worker/follow-ups?limit=${limit}`); }
  /** Report a follow-up actually went out — advances the stage and restarts the clock. */
  followUpSent(contactId) { return this.#req('/api/worker/follow-up-sent', { method: 'POST', body: { contactId } }); }
  /** Is this post a real opening? { isHiring, confidence, role, topic } */
  postIntent(text) { return this.#req('/api/worker/post-intent', { method: 'POST', body: { text } }); }
  /**
   * Ask permission to contact someone AND record it in one call. Returns { ok } or
   * { ok:false, reason }. Must be called immediately before sending — it is the throttle
   * and the duplicate check, and it writes the row that enforces both.
   */
  outreachClaim(body) { return this.#req('/api/worker/outreach-claim', { method: 'POST', body }); }
  profile() { return this.#req('/api/worker/profile'); }
  resume() { return this.#req('/api/worker/resume'); }
  answer(question, options) { return this.#req('/api/worker/answer', { method: 'POST', body: { question, options } }); }
  // A screening question the automation hit → saved to Profile → Autofill answers so the
  // owner can keep/correct an answer. `answer` is what we used (blank if we couldn't).
  recordQuestion(question, answer, portal) {
    return this.#req('/api/worker/question', {
      method: 'POST', body: { question, answer, portal: portal || this.portal || null },
    });
  }
  // HR email harvested from a hiring post → backend stores the lead and (when Auto-email
  // is on) tailors + emails an application automatically.
  hrLead(lead) { return this.#req('/api/worker/hr-lead', { method: 'POST', body: lead }); }
  upsertContact(c) { return this.#req('/api/worker/contact', { method: 'POST', body: c }); }
  approvedMessages() { return this.#req('/api/worker/messages/approved'); }
  markSent(id) { return this.#req(`/api/worker/messages/${id}/sent`, { method: 'POST' }); }
  // Connection outreach: invites we're waiting on, the short note to attach, and lifecycle.
  pendingConnections() { return this.#req('/api/worker/contacts/pending'); }
  /** `topic` is what they posted about, so the note can reference something real. */
  connectionNote(contactId, topic = '') {
    return this.#req('/api/worker/connection-note', { method: 'POST', body: { contactId, topic } });
  }
  setConnectionStatus(id, body) { return this.#req(`/api/worker/contact/${id}/connection-status`, { method: 'POST', body }); }
}
