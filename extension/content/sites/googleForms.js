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
    items.forEach((item) => {
      const q = questionText(item);
      if (!q) return;
      total++;
      const m = JP.match(q, profile);
      if (m && m.value) {
        const ok = fillTextInput(item, m.value) || selectOption(item, m.value);
        if (ok) filled++;
      }
    });
    return { filled, total };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type !== 'FILL') return;
    JP.getProfile(msg.force).then((profile) => {
      const { filled, total } = fill(profile);
      JP.showBadge(`JobPilot · filled ${filled} of ${total} questions — review & submit`);
      sendResponse({ ok: true, filled, total, site: 'googleForms' });
    }).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  });
})();
