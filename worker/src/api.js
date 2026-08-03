// Thin client for the backend's /api/worker/** protocol. Auth is the worker token
// (X-Worker-Token), bound server-side to the owning user. No portal passwords ever
// touch the backend — the browser on this PC holds the real logged-in sessions.

export class Api {
  constructor(baseUrl, token) {
    this.base = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  async #req(path, { method = 'GET', body } = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        'X-Worker-Token': this.token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  hello() { return this.#req('/api/worker/hello'); }
  next() { return this.#req('/api/worker/next'); }
  event(e) { return this.#req('/api/worker/event', { method: 'POST', body: e }); }
  frame(f) { return this.#req('/api/worker/frame', { method: 'POST', body: f }); }
  runStatus(runId, status, currentAction) {
    return this.#req(`/api/worker/run/${runId}/status`, { method: 'POST', body: { status, currentAction } });
  }
  session(portal, loggedIn, detail) {
    return this.#req('/api/worker/session', { method: 'POST', body: { portal, loggedIn, detail } });
  }
  connectionActions() { return this.#req('/api/worker/connection-actions'); }
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
  recordQuestion(question, answer) { return this.#req('/api/worker/question', { method: 'POST', body: { question, answer } }); }
  // HR email harvested from a hiring post → backend stores the lead and (when Auto-email
  // is on) tailors + emails an application automatically.
  hrLead(lead) { return this.#req('/api/worker/hr-lead', { method: 'POST', body: lead }); }
  upsertContact(c) { return this.#req('/api/worker/contact', { method: 'POST', body: c }); }
  draftMessage(m) { return this.#req('/api/worker/message/draft', { method: 'POST', body: m }); }
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
