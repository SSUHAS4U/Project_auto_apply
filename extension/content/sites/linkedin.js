// LinkedIn: inject Save button + autofill Easy Apply text fields (never submits).
(function () {
  const JP = window.JobPilot;
  if (!JP) return;
  window.__jobpilotHandled = true;
  window.__jobpilotSaves = true; // this script has its own SAVE_CURRENT handler

  function extract() {
    return {
      title: JP.textOf(['.job-details-jobs-unified-top-card__job-title', 'h1.t-24', 'h1']),
      company: JP.textOf(['.job-details-jobs-unified-top-card__company-name', '.jobs-unified-top-card__company-name', 'a[href*="/company/"]']),
      location: JP.textOf(['.job-details-jobs-unified-top-card__bullet', '.jobs-unified-top-card__bullet']),
      url: location.href.split('?')[0],
    };
  }

  function injectWhenReady() {
    if (document.querySelector('h1')) JP.injectSaveButton('linkedin', extract);
  }
  injectWhenReady();
  new MutationObserver(injectWhenReady).observe(document.body, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === 'FILL') {
      if (!JP.isEnabled()) { sendResponse({ ok: false, error: 'JobPilot is turned off — flip the toggle in the popup.' }); return; }
      JP.getProfile(msg.force).then((profile) => {
        const { filled, total, report } = JP.fillTextInputs(profile);
        JP.showBadge(`JobPilot · filled ${filled} of ${total} — review & submit`);
        sendResponse({ ok: true, filled, total, report, site: 'linkedin' });
      }).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'SAVE_CURRENT') {
      JP.saveJob({ ...extract(), sourceSite: 'linkedin' })
        .then((data) => sendResponse({ ok: true, data }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
  });
})();
