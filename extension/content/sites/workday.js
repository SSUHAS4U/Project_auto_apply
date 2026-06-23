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
    const inputs = smart.deepQueryAll('input, textarea');
    for (const el of inputs) {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'file', 'checkbox', 'radio', 'password', 'search'].includes(type)) continue;
      if (el.disabled || el.readOnly || el.offsetParent === null) continue;
      if ((el.value || '').trim()) continue;
      const label = JP.deriveLabel(el);
      if (!label) continue;
      const m = JP.match(label, profile);
      if (!m || !m.value) continue;
      total++;
      try {
        if (isCombobox(el)) {
          if (await smart.fillTypeahead(el, m.value)) { JP.highlight(el); filled++; }
        } else {
          smart.setValue(el, m.value); JP.highlight(el); filled++;
        }
        await smart.sleep(140); // let Workday's state settle between fields
      } catch (_) { /* keep going */ }
    }
    return { filled, total };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type !== 'FILL') return;
    JP.getProfile(msg.force)
      .then((profile) => fillWorkday(profile))
      .then(({ filled, total }) => {
        JP.showBadge(`JobPilot · Workday — filled ${filled} of ${total} fields. Typeaheads: pick if not exact. Review & submit.`);
        sendResponse({ ok: true, filled, total, site: 'workday' });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  });
})();
