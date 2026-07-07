// Workday adapter. Workday powers a huge share of enterprise applications and uses
// custom typeahead/combobox widgets (data-automation-id) that a naive value-setter can't
// drive. This self-activates only when the page fingerprints as Workday.
(function () {
  const smart = window.JobPilotSmart;
  const JP = window.JobPilot;
  if (!smart || !JP) return;
  if (smart.detectAts() !== 'workday') return; // fingerprint — only run on Workday
  window.__jobpilotHandled = true; // stop the generic filler from double-handling

  const isCombobox = (el) =>
    el.getAttribute('role') === 'combobox'
    || el.getAttribute('aria-autocomplete')
    || el.getAttribute('aria-haspopup') === 'listbox'
    || !!el.closest('[data-automation-id*="multiSelect" i], [data-automation-id*="selectinput" i], [data-uxi-widget-type], [data-automation-id="searchBox"]');

  async function fillWorkday(profile) {
    let filled = 0, total = 0;
    const report = [];
    const inputs = smart.deepQueryAll('input, textarea');
    for (const el of inputs) {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'file', 'checkbox', 'radio', 'password', 'search'].includes(type)) continue;
      if (el.disabled || el.readOnly || el.offsetParent === null) continue;
      if ((el.value || '').trim()) continue;
      const label = JP.deriveLabel(el);
      if (!label) continue;
      const m = JP.matchDetailed(label, profile);
      if (!m.value) {
        report.push({ label, status: 'unfilled', key: m.key, reason: m.reason });
        continue;
      }
      total++;
      let ok = false;
      try {
        if (isCombobox(el)) {
          if (await smart.fillTypeahead(el, m.value)) { JP.highlight(el); filled++; ok = true; }
        } else {
          smart.setValue(el, m.value); JP.highlight(el); filled++; ok = true;
        }
        await smart.sleep(140); // let Workday's state settle between fields
      } catch (_) { /* keep going */ }
      report.push(ok
        ? { label, status: 'filled', key: m.key }
        : { label, status: 'unfilled', key: m.key, reason: 'widget-failed', value: m.value });
    }
    JP.lastFillReport = report;
    return { filled, total, report };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type !== 'FILL') return;
    if (!JP.isEnabled()) { sendResponse({ ok: false, error: 'JobPilot is turned off — flip the toggle in the popup.' }); return; }
    JP.getProfile(msg.force)
      .then((profile) => fillWorkday(profile))
      .then(({ filled, total, report }) => {
        JP.showBadge(`JobPilot · Workday — filled ${filled} of ${total} fields. Typeaheads: pick if not exact. Review & submit.`);
        sendResponse({ ok: true, filled, total, report, site: 'workday' });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  });
})();
