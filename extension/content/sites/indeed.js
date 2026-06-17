// Indeed: inject Save button + autofill apply text fields (never submits).
(function () {
  const JP = window.JobPilot;
  if (!JP) return;
  window.__jobpilotHandled = true;

  function extract() {
    return {
      title: JP.textOf(['h1.jobsearch-JobInfoHeader-title', 'h2[data-testid="jobsearch-JobInfoHeader-title"]', 'h1']),
      company: JP.textOf(['[data-company-name="true"]', '.jobsearch-CompanyInfoContainer a', 'div[data-testid="inlineHeader-companyName"]']),
      location: JP.textOf(['[data-testid="job-location"]', '.jobsearch-JobInfoHeader-subtitle div', 'div[data-testid="inlineHeader-companyLocation"]']),
      url: location.href.split('&')[0],
    };
  }

  function injectWhenReady() {
    if (document.querySelector('h1, h2')) JP.injectSaveButton('indeed', extract);
  }
  injectWhenReady();
  new MutationObserver(injectWhenReady).observe(document.body, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === 'FILL') {
      JP.getProfile(msg.force).then((profile) => {
        const { filled, total } = JP.fillTextInputs(profile);
        JP.showBadge(`JobPilot · filled ${filled} of ${total} — review & submit`);
        sendResponse({ ok: true, filled, total, site: 'indeed' });
      }).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'SAVE_CURRENT') {
      JP.saveJob({ ...extract(), sourceSite: 'indeed' })
        .then((data) => sendResponse({ ok: true, data }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
  });
})();
