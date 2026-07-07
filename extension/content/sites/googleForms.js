// Google Forms filler. Questions live in [role="listitem"] containers.
(function () {
  const JP = window.JobPilot;
  if (!JP) return;
  window.__jobpilotHandled = true;

  function questionText(item) {
    const heading = item.querySelector('[role="heading"]')
      || item.querySelector('.M7eMe, .freebirdFormviewerComponentsQuestionBaseTitle');
    return JP.norm(heading ? heading.textContent : '');
  }

  function fillTextInput(item, value) {
    const input = item.querySelector('input[type="text"], textarea, input[type="email"], input[type="url"]');
    if (input) { JP.setNativeValue(input, value); JP.highlight(input); return true; }
    return false;
  }

  // Click a radio/checkbox whose visible label matches the value.
  function selectOption(item, value) {
    const target = JP.norm(value);
    const opts = item.querySelectorAll('[role="radio"], [role="checkbox"]');
    for (const o of opts) {
      const lbl = JP.norm(o.getAttribute('aria-label') || o.textContent || '');
      if (lbl && (lbl === target || lbl.includes(target) || target.includes(lbl))) {
        o.click(); JP.highlight(o); return true;
      }
    }
    return false;
  }

  function fill(profile) {
    const items = document.querySelectorAll('[role="listitem"]');
    let filled = 0, total = 0;
    const report = [];
    items.forEach((item) => {
      const q = questionText(item);
      if (!q) return;
      total++;
      const m = JP.matchDetailed(q, profile);
      if (m.value) {
        const ok = fillTextInput(item, m.value) || selectOption(item, m.value);
        if (ok) { filled++; report.push({ label: q, status: 'filled', key: m.key }); }
        else report.push({ label: q, status: 'unfilled', key: m.key, reason: 'widget-failed', value: m.value });
      } else {
        report.push({ label: q, status: 'unfilled', key: m.key, reason: m.reason });
      }
    });
    JP.lastFillReport = report;
    return { filled, total, report };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type !== 'FILL') return;
    if (!JP.isEnabled()) { sendResponse({ ok: false, error: 'JobPilot is turned off — flip the toggle in the popup.' }); return; }
    JP.getProfile(msg.force).then((profile) => {
      const { filled, total, report } = fill(profile);
      JP.showBadge(`JobPilot · filled ${filled} of ${total} questions — review & submit`);
      sendResponse({ ok: true, filled, total, report, site: 'googleForms' });
    }).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  });
})();
