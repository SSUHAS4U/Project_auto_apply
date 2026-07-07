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
    const report = [];
    items.forEach((item) => {
      const q = questionText(item);
      if (!q) return;
      total++;
      const m = JP.matchDetailed(q, profile);
      if (m.value) {
        if (fillInput(item, m.value) || selectChoice(item, m.value)) {
          filled++; report.push({ label: q, status: 'filled', key: m.key });
        } else report.push({ label: q, status: 'unfilled', key: m.key, reason: 'widget-failed', value: m.value });
      } else {
        report.push({ label: q, status: 'unfilled', key: m.key, reason: m.reason });
      }
    });
    if (total === 0) return JP.fillTextInputs(profile); // fallback
    JP.lastFillReport = report;
    return { filled, total, report };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type !== 'FILL') return;
    if (!JP.isEnabled()) { sendResponse({ ok: false, error: 'JobPilot is turned off — flip the toggle in the popup.' }); return; }
    JP.getProfile(msg.force).then((profile) => {
      const { filled, total, report } = fill(profile);
      JP.showBadge(`JobPilot · filled ${filled} of ${total} — review & submit`);
      sendResponse({ ok: true, filled, total, report, site: 'msForms' });
    }).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  });
})();
