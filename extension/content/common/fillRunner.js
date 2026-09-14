// JobPilot fill runner — the ONE handler for a Fill request, on every site.
//
// Before this, each of the seven site adapters registered its own `FILL` listener with its own
// filling implementation, so behaviour depended on which file happened to match the URL and a
// fix applied to one never reached the others. There is now a single path, and no branch in it
// tests the hostname.
//
// Two passes, deliberately in this order:
//
//   1. LOCAL  the profile dictionary answers the fields it certainly knows (name, email, phone)
//             with no network at all, so the form visibly fills the instant you click.
//   2. REMOTE everything left goes up in ONE batched request. The backend answers from your
//             saved Q&A bank first, then deterministic profile facts, and only sends what is
//             genuinely unknown to the model — so this is usually one model call for a whole
//             form, not one per field. That matters on a GCP micro-VM: the round trip is the
//             cost, and there is exactly one of them.
//
// The old design had no step 2 at all: a label the dictionary did not recognise was left empty.
(function () {
  const JP = window.JobPilot;
  const Form = window.JobPilotForm;
  if (!JP || !Form) return;
  if (window.__jobpilotRunner) return;
  window.__jobpilotRunner = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function msg(type, extra) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...extra }, (r) => resolve(r || { ok: false, error: 'no response' }));
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  // A field worth asking the backend about. Fields already carrying a value are left alone —
  // overwriting what the page (or the user) already put there is never wanted.
  function isPending(f) {
    if (f.value && f.value.trim()) return false;
    // A label we could not derive at all AND no context to recover it from is not answerable;
    // sending it only wastes model budget and invites a confident guess at nothing.
    return !!(f.label || f.context);
  }

  /** Pass 1: the local dictionary, for fields it is certain about. */
  function localPass(fields, profile) {
    const done = [];
    for (const f of fields) {
      if (!isPending(f)) continue;
      // Only trust the dictionary on a confidently-derived label. On a weak one (a placeholder,
      // a humanised attribute name) a substring match is as likely to be wrong as right, so
      // that field goes to the backend instead, which has the whole profile and the bank.
      if (f.confidence < 0.8) continue;
      const m = JP.match(JP.norm(f.label), profile);
      if (!m || !m.value) continue;
      done.push({ f, value: m.value, source: 'profile', reason: 'from your profile' });
    }
    return done;
  }

  /** Pass 2: one batched call for everything still empty. */
  async function remotePass(fields) {
    const payload = fields.map((f) => ({
      id: f.id,
      label: f.label,
      kind: f.kind,
      required: String(!!f.required),
      options: f.options || [],
      // Sent so a weak or wrong label is recoverable. The old /answer path sent none of this.
      context: f.context || '',
      confidence: f.confidence,
    }));
    const r = await msg('ASSIST_FILL_FORM', { fields: payload });
    if (!r || !r.ok) return { answers: {}, error: (r && r.error) || 'assist unavailable' };
    const answers = (r.data && r.data.answers) || {};
    return { answers };
  }

  async function applyAll(plan) {
    let filled = 0;
    const report = [];
    for (const { f, value, source, reason } of plan) {
      const ok = await Form.write(f, value);
      if (ok) { filled++; Form.highlight(f.el); }
      report.push({
        label: f.label || '(unlabelled)', kind: f.kind,
        status: ok ? 'filled' : 'write-failed',
        value: ok ? value : undefined, source, reason,
      });
      // Comboboxes drive a popup and a network search; the others are instant. Only pay the
      // settle delay where the widget actually needs it.
      if (f.kind === 'combobox') await sleep(120);
    }
    return { filled, report };
  }

  async function runOnce(profile) {
    const fields = Form.collect();
    const pending = fields.filter(isPending);
    if (!pending.length) return { filled: 0, total: fields.length, report: [], pending: 0 };

    const plan = localPass(pending, profile);
    const decided = new Set(plan.map((p) => p.f.id));
    const remaining = pending.filter((f) => !decided.has(f.id));

    let error = null;
    if (remaining.length) {
      const { answers, error: e } = await remotePass(remaining);
      error = e || null;
      for (const f of remaining) {
        const a = answers[f.id];
        if (a && a.value) plan.push({ f, value: a.value, source: a.source, reason: a.reason });
      }
    }

    const { filled, report } = await applyAll(plan);
    // Everything asked about that came back with nothing — named, so the popup can say WHICH
    // field it could not answer instead of only a count.
    const answered = new Set(plan.map((p) => p.f.id));
    for (const f of pending) {
      if (answered.has(f.id)) continue;
      report.push({
        label: f.label || '(unlabelled)', kind: f.kind, status: 'unanswered',
        reason: error || (f.label ? 'no saved answer and the model did not return one'
          : 'this field has no readable label — save an answer on it once with the ✨ pill'),
      });
    }
    return { filled, total: fields.length, pending: pending.length, report, error };
  }

  /**
   * Multi-step forms. A wizard renders step 2 only after step 1 is filled and advanced, so a
   * single pass fills a third of a Workday application and reports success. After an explicit
   * Fill we watch briefly and fill fields that APPEAR, then stop.
   *
   * Bounded on purpose: this types into a real job application, so it runs only in the window
   * following a click the user made, never on its own, and never more than a few rounds.
   */
  async function runWithFollowUp(profile, onProgress) {
    const first = await runOnce(profile);
    let total = first.filled;
    const report = [...first.report];

    for (let round = 0; round < 3; round++) {
      const appeared = await waitForNewFields(6000);
      if (!appeared) break;
      const next = await runOnce(profile);
      if (!next.filled) break;
      total += next.filled;
      report.push(...next.report);
      if (onProgress) onProgress(total);
    }
    return { ...first, filled: total, report };
  }

  // Resolve true as soon as an unfilled field exists that did not a moment ago.
  function waitForNewFields(timeout) {
    const before = new Set(Form.collect().map((f) => f.id));
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; obs.disconnect(); clearTimeout(t); resolve(v); } };
      const obs = new MutationObserver(() => {
        const now = Form.collect().filter((f) => !f.value || !f.value.trim());
        if (now.some((f) => !before.has(f.id))) finish(true);
      });
      try {
        obs.observe(document.documentElement, { childList: true, subtree: true });
      } catch (_) { return resolve(false); }
      const t = setTimeout(() => finish(false), timeout);
    });
  }

  chrome.runtime.onMessage.addListener((m, _s, sendResponse) => {
    if (m.type !== 'FILL') return undefined;
    if (!JP.isEnabled()) {
      sendResponse({ ok: false, error: 'JobPilot is turned off — flip the toggle in the popup.' });
      return undefined;
    }
    (async () => {
      try {
        const profile = await JP.getProfile(m.force);
        JP.showBadge('JobPilot · reading the form…');
        const res = await runWithFollowUp(profile, (n) => JP.showBadge(`JobPilot · filled ${n}…`));
        JP.lastFillReport = res.report;
        const missed = res.report.filter((r) => r.status !== 'filled').length;
        JP.showBadge(res.filled
          ? `JobPilot · filled ${res.filled} field${res.filled === 1 ? '' : 's'}`
            + (missed ? ` · ${missed} left for you` : '') + ' — review & submit'
          : `JobPilot · nothing to fill${res.error ? ' — ' + res.error : ''}`);
        sendResponse({ ok: true, filled: res.filled, total: res.total, report: res.report });
      } catch (e) {
        JP.showBadge('JobPilot · ' + e.message);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;   // async
  });

  window.JobPilotRunner = { runOnce, runWithFollowUp, localPass, isPending };
})();
