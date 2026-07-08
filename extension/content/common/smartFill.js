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

  // --- Drive a CUSTOM dropdown (div/button widget, not an <input> or <select>) ---
  // Click to open → if a search box appears, type → wait for options → click the match.
  async function fillCustomDropdown(trigger, value, opts = {}) {
    const optionSel = opts.optionSelector
      || '[role="option"], li[role="option"], [data-automation-id="promptOption"], .select__option, [class*="option" i][role], [class*="menu" i] li, [role="menuitem"]';
    try { trigger.scrollIntoView({ block: 'nearest' }); } catch (_) { /* ignore */ }
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    trigger.click();
    trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(160);

    // Many widgets (react-select, Workday) reveal a search input once opened.
    const search = [...document.querySelectorAll('input[role="combobox"], .select__input input, [role="dialog"] input, [role="listbox"] input, [aria-expanded="true"] input')]
      .filter((i) => i.offsetParent !== null)[0];
    if (search) { await typeInto(search, value, 45); await sleep(320); }

    const options = await waitFor(() => {
      const o = [...document.querySelectorAll(optionSel)].filter((x) => x.offsetParent !== null && norm(x.textContent));
      return o.length ? o : null;
    }, { timeout: opts.timeout || 3500 });
    if (!options || !options.length) {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }
    const want = norm(value);
    const target = options.find((o) => norm(o.textContent) === want)
      || options.find((o) => norm(o.textContent).includes(want))
      || options.find((o) => want.includes(norm(o.textContent)))
      || options[0];
    try { target.scrollIntoView({ block: 'nearest' }); } catch (_) { /* ignore */ }
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.click();
    await sleep(140);
    return true;
  }

  // Open a custom dropdown just long enough to READ its options, then close it.
  // Lets the review plan show a widget's real choices without committing anything.
  async function readDropdownOptions(trigger, opts = {}) {
    const optionSel = opts.optionSelector
      || '[role="option"], li[role="option"], [data-automation-id="promptOption"], [data-automation-id="menuItem"], .select__option, [class*="option" i][role], [role="menuitem"]';
    try { trigger.scrollIntoView({ block: 'nearest' }); } catch (_) { /* ignore */ }
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    trigger.click();
    trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(200);
    const options = await waitFor(() => {
      const o = [...document.querySelectorAll(optionSel)].filter((x) => x.offsetParent !== null && norm(x.textContent));
      return o.length ? o : null;
    }, { timeout: opts.timeout || 2500 });
    const texts = options
      ? [...new Set(options.map((o) => o.textContent.replace(/\s+/g, ' ').trim()))].filter(Boolean).slice(0, 40)
      : [];
    // Close without selecting: Escape to the trigger, then to the document.
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(120);
    return texts;
  }

  // Is this element a custom dropdown trigger (not a plain input/select)?
  function isCustomDropdown(el) {
    const tag = el.tagName;
    if (tag === 'SELECT' || (tag === 'INPUT' && !el.getAttribute('aria-haspopup'))) return false;
    const role = el.getAttribute('role');
    if (role === 'combobox' || role === 'listbox') return true;
    if (el.getAttribute('aria-haspopup') === 'listbox' || el.getAttribute('aria-haspopup') === 'menu') return true;
    const cls = (el.className && el.className.toString ? el.className.toString() : '');
    return /select__control|dropdown__control|combobox|Select-control/i.test(cls);
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

  window.JobPilotSmart = { deepQueryAll, setValue, waitFor, typeInto, fillTypeahead, fillCustomDropdown, readDropdownOptions, isCustomDropdown, detectAts, sleep, norm };
})();
