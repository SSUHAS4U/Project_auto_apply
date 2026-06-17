// Microsoft Forms filler. Question containers carry data-automation-id="questionItem".
(function () {
  const JP = window.JobPilot;
  if (!JP) return;
  window.__jobpilotHandled = true;

  function questionText(item) {
    const t = item.querySelector('[data-automation-id="questionTitle"]')
      || item.querySelector('.question-title-box, span[class*="text-format-content"]');
    return JP.norm(t ? t.textContent : '');
  }

  function fillInput(item, value) {
    const input = item.querySelector('input[type="text"], input[type="email"], textarea, input.office-form-textfield-input, input[type="tel"]');
    if (input) { JP.setNativeValue(input, value); JP.highlight(input); return true; }
    return false;
  }

  function selectChoice(item, value) {
    const target = JP.norm(value);
    const opts = item.querySelectorAll('[role="radio"], [role="checkbox"], label');
    for (const o of opts) {
      const lbl = JP.norm(o.getAttribute('aria-label') || o.textContent || '');
      if (lbl && (lbl === target || lbl.includes(target))) { o.click(); JP.highlight(o); return true; }
    }
    return false;
  }

  function fill(profile) {
    const items = document.querySelectorAll('[data-automation-id="questionItem"], div[class*="question-item"]');
    let filled = 0, total = 0;
    items.forEach((item) => {
      const q = questionText(item);
      if (!q) return;
      total++;
      const m = JP.match(q, profile);
      if (m && m.value && (fillInput(item, m.value) || selectChoice(item, m.value))) filled++;
    });
    if (total === 0) return JP.fillTextInputs(profile); // fallback
    return { filled, total };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type !== 'FILL') return;
    JP.getProfile(msg.force).then((profile) => {
      const { filled, total } = fill(profile);
      JP.showBadge(`JobPilot · filled ${filled} of ${total} — review & submit`);
      sendResponse({ ok: true, filled, total, site: 'msForms' });
    }).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  });
})();
