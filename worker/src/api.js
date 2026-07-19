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
  profile() { return this.#req('/api/worker/profile'); }
  resume() { return this.#req('/api/worker/resume'); }
  answer(question, options) { return this.#req('/api/worker/answer', { method: 'POST', body: { question, options } }); }
  // A question we couldn't answer → stored as PENDING so the owner fills it once.
  recordQuestion(question) { return this.#req('/api/worker/question', { method: 'POST', body: { question } }); }
  upsertContact(c) { return this.#req('/api/worker/contact', { method: 'POST', body: c }); }
  draftMessage(m) { return this.#req('/api/worker/message/draft', { method: 'POST', body: m }); }
  approvedMessages() { return this.#req('/api/worker/messages/approved'); }
  markSent(id) { return this.#req(`/api/worker/messages/${id}/sent`, { method: 'POST' }); }
}
