// Generic fallback filler for unknown ATS / form pages.
// Defers to a site-specific filler if one claimed the page (window.__jobpilotHandled).
(function () {
  const JP = window.JobPilot;
  if (!JP) return;

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type !== 'FILL' || window.__jobpilotHandled) return;
    JP.getProfile(msg.force).then((profile) => {
      const { filled, total } = JP.fillTextInputs(profile);
      JP.showBadge(`JobPilot · filled ${filled} of ${total} — review & submit`);
      sendResponse({ ok: true, filled, total, site: 'generic' });
    }).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  });
})();
