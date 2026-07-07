// Naukri: inject Save button + autofill apply text fields (never submits).
(function () {
  const JP = window.JobPilot;
  if (!JP) return;
  window.__jobpilotHandled = true;
  window.__jobpilotSaves = true; // this script has its own SAVE_CURRENT handler

  function extract() {
    return {
      title: JP.textOf(['.styles_jd-header-title__rZwM1', 'h1.jd-header-title', 'h1']),
      company: JP.textOf(['.styles_jd-header-comp-name__MvqAI a', '.jd-header-comp-name a', 'a[href*="-jobs-careers-"]']),
      location: JP.textOf(['.styles_jhc__location__W_pVs', '.location', 'span[class*="location"]']),
      url: location.href.split('?')[0],
    };
  }

  function injectWhenReady() {
    if (document.querySelector('h1')) JP.injectSaveButton('naukri', extract);
  }
  injectWhenReady();
  new MutationObserver(injectWhenReady).observe(document.body, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === 'FILL') {
      if (!JP.isEnabled()) { sendResponse({ ok: false, error: 'JobPilot is turned off — flip the toggle in the popup.' }); return; }
      JP.getProfile(msg.force).then((profile) => {
        const { filled, total, report } = JP.fillTextInputs(profile);
        JP.showBadge(`JobPilot · filled ${filled} of ${total} — review & submit`);
        sendResponse({ ok: true, filled, total, report, site: 'naukri' });
      }).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'SAVE_CURRENT') {
      JP.saveJob({ ...extract(), sourceSite: 'naukri' })
        .then((data) => sendResponse({ ok: true, data }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
  });
})();
