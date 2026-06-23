// JobPilot smart-fill engine — advanced DOM automation for framework-driven forms
// (React/Vue/Angular controlled inputs, Workday typeaheads, Shadow DOM).
// Exposes window.JobPilotSmart.
(function () {
  if (window.JobPilotSmart) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // --- Shadow DOM traversal: query across all open shadow roots -------------
  function deepQueryAll(selector, root = document) {
    const out = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.querySelectorAll) {
        try { out.push(...node.querySelectorAll(selector)); } catch (_) { /* bad selector on root */ }
        node.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
      }
    };
    walk(root);
    return out;
  }

  // --- Trusted value set: frameworks ignore a bare el.value = x -------------
  function nativeSetter(el) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  }

  function setValue(el, value) {
    try { el.focus(); } catch (_) { /* detached */ }
    const set = nativeSetter(el);
    if (set) set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // --- Wait for async content (typeahead popups) via MutationObserver -------
  function waitFor(test, { timeout = 4000 } = {}) {
    const run = () => { try { return typeof test === 'string' ? document.querySelector(test) : test(); } catch (_) { return null; } };
    return new Promise((resolve) => {
      const hit = run();
      if (hit) return resolve(hit);
      const obs = new MutationObserver(() => { const f = run(); if (f) { obs.disconnect(); resolve(f); } });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      setTimeout(() => { obs.disconnect(); resolve(run() || null); }, timeout);
    });
  }

  // --- Human-like char-by-char typing (triggers search-indexed typeaheads) --
  async function typeInto(el, text, perChar = 45) {
    try { el.focus(); } catch (_) { /* ignore */ }
    const set = nativeSetter(el);
    if (set) set.call(el, ''); else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    let cur = '';
    for (const ch of String(text)) {
      cur += ch;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      if (set) set.call(el, cur); else el.value = cur;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await sleep(perChar);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // --- Drive a typeahead / combobox: type → wait for options → pick match ---
  async function fillTypeahead(el, value, opts = {}) {
    const optionSel = opts.optionSelector
      || '[role="option"], [data-automation-id="promptOption"], li[role="option"], .css-option, .select__option, [data-automation-id="menuItem"]';
    await typeInto(el, value, opts.perChar || 55);
    await sleep(opts.searchWait || 400);
    const options = await waitFor(() => {
      const o = [...document.querySelectorAll(optionSel)].filter((x) => x.offsetParent !== null && norm(x.textContent));
      return o.length ? o : null;
    }, { timeout: opts.timeout || 3800 });
    if (!options || !options.length) {
      // Some widgets confirm on Enter instead of a clickable list.
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return false;
    }
    const want = norm(value);
    const target = options.find((o) => norm(o.textContent) === want)
      || options.find((o) => norm(o.textContent).includes(want))
      || options[0];
    try { target.scrollIntoView({ block: 'nearest' }); } catch (_) { /* ignore */ }
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.click();
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(120);
    return true;
  }

  // --- ATS fingerprinting (strategy pattern) --------------------------------
  function detectAts() {
    const h = location.hostname;
    if (/myworkdayjobs|workday/.test(h) || document.querySelector('[data-automation-id]')) return 'workday';
    if (/greenhouse\.io/.test(h) || document.querySelector('#application_form, [id^="application"]')) return 'greenhouse';
    if (/lever\.co/.test(h)) return 'lever';
    if (/ashbyhq/.test(h)) return 'ashby';
    if (/icims/.test(h)) return 'icims';
    if (/successfactors|sapsf|jobs\.sap/.test(h)) return 'successfactors';
    if (/taleo/.test(h)) return 'taleo';
    if (/smartrecruiters/.test(h)) return 'smartrecruiters';
    if (/oraclecloud|taleo|recruiting\.oracle/.test(h)) return 'oracle';
    return 'generic';
  }

  window.JobPilotSmart = { deepQueryAll, setValue, waitFor, typeInto, fillTypeahead, detectAts, sleep, norm };
})();
