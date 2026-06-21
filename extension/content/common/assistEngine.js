// JobPilot assist engine — AI answers for free-text application questions,
// a "save to autofill questions" button, and one-click cover-letter attach.
// Depends on window.JobPilot (fieldEngine.js) for setNativeValue/getProfile.
(function () {
  if (window.JobPilotAssist) return;

  function msg(type, extra) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...extra }, (resp) => {
        if (!resp) return reject(new Error('extension background not reachable'));
        resp.ok ? resolve(resp.data) : reject(new Error(resp.error));
      });
    });
  }

  // ---- question detection -------------------------------------------------

  // A free-text question field worth AI-answering: a textarea, a contenteditable
  // textbox, or a long-answer text input whose label reads like a question.
  function isQuestionField(el) {
    if (!el || el.disabled || el.readOnly || el.offsetParent === null) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') return true;
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (!['text', ''].includes(t)) return false;
      const label = deriveQuestion(el);
      return label.length > 30 || /\?\s*\*?\s*$/.test(label);
    }
    return false;
  }

  // Generic placeholder labels that are NOT the real question (Google/MS Forms etc.).
  const GENERIC_LABEL = /^(your answer|answer|response|short answer|long answer|paragraph text|text|enter your answer|type here|untitled question|required question)\b/i;

  // Original-case question text (unlike fieldEngine's normalized label).
  function deriveQuestion(el) {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const strip = (s) => clean(s).replace(/\s*\*\s*$/, '').replace(/\s*Required question\s*$/i, '').trim();

    // 1. The enclosing question heading (Google/MS Forms put the real question here, while
    //    the field's own aria-label is just "Your answer" — so this MUST come first).
    const item = el.closest && el.closest('[role="listitem"], .freebirdFormviewerComponentsQuestionBaseRoot');
    if (item) {
      const head = item.querySelector('[role="heading"], .M7eMe, .freebirdFormviewerComponentsQuestionBaseTitle');
      if (head && strip(head.textContent).length > 4) return strip(head.textContent).slice(0, 500);
    }
    // 2. aria-label — but ignore the generic placeholder ones.
    const al = el.getAttribute && el.getAttribute('aria-label');
    if (al && !GENERIC_LABEL.test(clean(al))) return strip(al);
    // 3. aria-labelledby → referenced element.
    const lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      const ref = document.getElementById(lb);
      if (ref && strip(ref.textContent).length > 4) return strip(ref.textContent).slice(0, 500);
    }
    // 4. <label for=id> or wrapping label.
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl && strip(lbl.textContent).length > 4) return strip(lbl.textContent).slice(0, 500);
    }
    const wrap = el.closest && el.closest('label');
    if (wrap && strip(wrap.textContent).length > 4) return strip(wrap.textContent).slice(0, 500);
    // 5. A heading/label/legend in a nearby container.
    const box = el.closest && el.closest('li, fieldset, .form-group, .field, div, section');
    if (box) {
      const head = box.querySelector('[role="heading"], h1, h2, h3, h4, label, legend, [class*="title"], [class*="question"]');
      if (head && strip(head.textContent).length > 8) return strip(head.textContent).slice(0, 500);
    }
    // 6. Last resorts.
    const prev = el.previousElementSibling;
    if (prev && strip(prev.textContent).length > 8) return strip(prev.textContent).slice(0, 500);
    if (el.placeholder && !GENERIC_LABEL.test(clean(el.placeholder))) return strip(el.placeholder);
    return clean(el.name || '');
  }

  function readValue(el) {
    return el.getAttribute && el.getAttribute('contenteditable') === 'true'
      ? (el.textContent || '') : (el.value || '');
  }

  function writeValue(el, val) {
    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
      el.textContent = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      window.JobPilot.setNativeValue(el, val);
    }
    window.JobPilot.highlight(el);
  }

  // ---- per-field toolbar (✨ AI answer · 💾 save) --------------------------

  function toolbar(el) {
    if (el.dataset.jobpilotAssist) return;
    el.dataset.jobpilotAssist = '1';

    const bar = document.createElement('div');
    bar.className = 'jobpilot-assistbar';
    bar.style.cssText = 'display:inline-flex;gap:6px;margin:6px 0;z-index:2147483646;font:600 12px system-ui,sans-serif';

    const mk = (label, title, bg) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.title = title;
      b.style.cssText = `border:none;border-radius:8px;padding:5px 10px;cursor:pointer;color:#fff;background:${bg};box-shadow:0 2px 8px rgba(0,0,0,.25)`;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      return b;
    };

    const ai = mk('✨ AI answer', 'Generate an answer from your profile', 'linear-gradient(135deg,#6366f1,#4f46e5)');
    const save = mk('💾 Save', 'Add this Q&A to your autofill questions', '#0f766e');
    const note = document.createElement('span');
    note.style.cssText = 'align-self:center;color:#6b7280;font-weight:500';

    ai.addEventListener('click', async () => {
      const question = deriveQuestion(el);
      if (!question) { note.textContent = 'no question detected'; return; }
      ai.disabled = true; const old = ai.textContent; ai.textContent = '✨ thinking…';
      try {
        const r = await msg('ASSIST_ANSWER', { question });
        writeValue(el, r.answer);
        note.textContent = r.source === 'saved' ? '↺ from saved' : '✓ AI · saved';
      } catch (e) {
        note.textContent = '⚠ ' + e.message;
      } finally { ai.disabled = false; ai.textContent = old; }
    });

    save.addEventListener('click', async () => {
      const question = deriveQuestion(el);
      const answer = readValue(el).trim();
      if (!question) { note.textContent = 'no question detected'; return; }
      if (!answer) { note.textContent = 'type an answer first'; return; }
      save.disabled = true;
      try { await msg('SAVE_QA', { question, answer }); note.textContent = '✓ saved to autofill'; }
      catch (e) { note.textContent = '⚠ ' + e.message; }
      finally { save.disabled = false; }
    });

    bar.append(ai, save, note);
    // Place the bar right after the field (works across form layouts).
    if (el.parentNode) el.parentNode.insertBefore(bar, el.nextSibling);
  }

  // Sites that are clearly NOT job applications — never inject the ✨/Save buttons here.
  const DENY_HOSTS = /(^|\.)(chat\.openai|chatgpt|claude\.ai|gemini\.google|bard\.google|copilot\.microsoft|bing|perplexity|you|poe|phind|google|duckduckgo|youtube|x|twitter|facebook|instagram|reddit|whatsapp|telegram|discord|slack|notion|figma|stackoverflow|github|gitlab)\.com/i;
  // Sites that ARE application/recruiting forms — always allow.
  const ALLOW_HOSTS = /(greenhouse\.io|lever\.co|ashbyhq\.com|myworkday|workday|icims\.com|smartrecruiters|bamboohr|taleo|successfactors|jobvite|workable|recruitee|teamtailor|breezy\.hr|naukri\.com|indeed\.com|linkedin\.com|wellfound\.com|instahyre|hirist|cutshort|forms\.office\.com|forms\.gle|docs\.google\.com)/i;

  function looksLikeApplicationForm() {
    const host = location.hostname;
    if (ALLOW_HOSTS.test(host)) return true;
    if (DENY_HOSTS.test(host)) return false;
    // Generic page: only treat it as an application if the URL/title says so AND it has a form.
    const hay = (location.href + ' ' + document.title).toLowerCase();
    const jobby = /(apply|application|career|job|recruit|vacancy|opening|hiring|candidate|position)/.test(hay);
    const hasUpload = !!document.querySelector('input[type="file"]');
    const fields = document.querySelectorAll('form textarea, form input[type="text"], form input[type="email"], [role="listitem"]').length;
    return (jobby && (hasUpload || fields >= 3));
  }

  function enhance() {
    if (!looksLikeApplicationForm()) return; // don't litter chat/search pages with buttons
    document.querySelectorAll('textarea, input, [contenteditable="true"]').forEach((el) => {
      if (isQuestionField(el)) {
        try { toolbar(el); } catch (_) { /* keep scanning */ }
      }
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const looksLikeQuestion = (q) => q.length > 40 || /\?/.test(q);
  const labelOf = (o) => (o.getAttribute('aria-label') || o.getAttribute('data-value') || o.textContent || '').replace(/\s+/g, ' ').trim();

  // Group the page into question units (Google/MS Forms listitems, or generic fields).
  function questionUnits() {
    const items = [...document.querySelectorAll('[role="listitem"]')].filter((el) => el.offsetParent !== null);
    if (items.length) {
      return items.map((el) => ({ container: el, q: unitQuestion(el) })).filter((u) => u.q);
    }
    // Generic HTML forms: one unit per field / radio-checkbox group.
    const units = [];
    const seenNames = new Set();
    document.querySelectorAll('input, textarea, select, [contenteditable="true"]').forEach((el) => {
      if (el.offsetParent === null || el.disabled) return;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password'].includes(type)) return;
      if ((type === 'radio' || type === 'checkbox') && el.name) {
        if (seenNames.has(type + el.name)) return;
        seenNames.add(type + el.name);
      }
      const container = el.closest('fieldset, .form-group, li, div, p, section') || el.parentElement;
      units.push({ container, q: deriveQuestion(el), field: el });
    });
    return units.filter((u) => u.q);
  }

  function unitQuestion(item) {
    const head = item.querySelector('[role="heading"], .M7eMe');
    let q = (head && head.textContent) ? head.textContent : deriveQuestion(item);
    return q.replace(/\s+/g, ' ').replace(/\*\s*$/, '').trim();
  }

  function ariaOptions(item, role) {
    return [...item.querySelectorAll(`[role="${role}"]`)].filter((o) => o.offsetParent !== null);
  }

  // Answer one question unit using the right strategy for its control type.
  async function answerUnit(u) {
    const item = u.container, q = u.q;
    if (!q) return false;

    // --- single choice: ARIA radios (incl. linear scale) or native radios ---
    let radios = ariaOptions(item, 'radio');
    let native = !radios.length ? [...item.querySelectorAll('input[type="radio"]')].filter((r) => r.offsetParent !== null) : [];
    if (radios.length || native.length) {
      const els = radios.length ? radios : native;
      const options = els.map((e) => radios.length ? labelOf(e) : nativeLabel(e)).filter(Boolean);
      if (!options.length) return false;
      const r = await msg('ASSIST_CHOOSE', { question: q, options, multi: false });
      const pick = norm((r.selected || [])[0] || '');
      const el = els.find((e) => norm(radios.length ? labelOf(e) : nativeLabel(e)) === pick)
        || els.find((e) => { const l = norm(radios.length ? labelOf(e) : nativeLabel(e)); return l && (l.includes(pick) || pick.includes(l)); });
      if (el) { clickInput(el); window.JobPilot.highlight(el); return true; }
      return false;
    }

    // --- multi choice: ARIA checkboxes or native checkboxes ---
    let checks = ariaOptions(item, 'checkbox');
    let nchecks = !checks.length ? [...item.querySelectorAll('input[type="checkbox"]')].filter((c) => c.offsetParent !== null) : [];
    if (checks.length || nchecks.length) {
      const els = checks.length ? checks : nchecks;
      const options = els.map((e) => checks.length ? labelOf(e) : nativeLabel(e)).filter(Boolean);
      if (!options.length) return false;
      const r = await msg('ASSIST_CHOOSE', { question: q, options, multi: true });
      const want = (r.selected || []).map(norm);
      let any = false;
      els.forEach((e) => {
        const l = norm(checks.length ? labelOf(e) : nativeLabel(e));
        const isOn = checks.length ? e.getAttribute('aria-checked') === 'true' : e.checked;
        if (want.includes(l) && !isOn) { clickInput(e); window.JobPilot.highlight(e); any = true; }
      });
      return any;
    }

    // --- dropdown (Google Forms listbox or native select) ---
    const listbox = item.querySelector('[role="listbox"]');
    if (listbox) {
      listbox.click();
      await sleep(180);
      let opts = [...document.querySelectorAll('[role="option"]')].filter((o) => o.offsetParent !== null);
      const options = opts.map(labelOf).filter((l) => l && !/^choose$|^select$/i.test(l));
      if (options.length) {
        const r = await msg('ASSIST_CHOOSE', { question: q, options, multi: false });
        const pick = norm((r.selected || [])[0] || '');
        opts = [...document.querySelectorAll('[role="option"]')];
        const el = opts.find((o) => norm(labelOf(o)) === pick);
        if (el) { el.click(); return true; }
      }
      listbox.click(); // close if nothing matched
      return false;
    }
    const select = item.querySelector('select');
    if (select) {
      const options = [...select.options].map((o) => o.text.trim()).filter((t) => t && !/^choose$|^select$/i.test(t));
      const r = await msg('ASSIST_CHOOSE', { question: q, options, multi: false });
      const pick = norm((r.selected || [])[0] || '');
      const opt = [...select.options].find((o) => norm(o.text) === pick);
      if (opt) { select.value = opt.value; select.dispatchEvent(new Event('change', { bubbles: true })); window.JobPilot.highlight(select); return true; }
      return false;
    }

    // --- date ---
    const dateInput = item.querySelector('input[type="date"]');
    if (dateInput && !dateInput.value) { fillDate(dateInput); return true; }

    // --- free text / paragraph ---
    const textEl = item.querySelector('textarea, [contenteditable="true"], input[type="text"], input[type="url"], input:not([type])');
    if (textEl && !readValue(textEl).trim()) {
      const isPara = textEl.tagName === 'TEXTAREA' || textEl.getAttribute('contenteditable') === 'true';
      if (!isPara && !looksLikeQuestion(q)) return false; // leave short profile fields to "Fill this form"
      const r = await msg('ASSIST_ANSWER', { question: q });
      writeValue(textEl, r.answer);
      return true;
    }
    return false;
  }

  function nativeLabel(input) {
    if (input.id) {
      const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (l) return l.textContent.replace(/\s+/g, ' ').trim();
    }
    const w = input.closest('label');
    if (w) return w.textContent.replace(/\s+/g, ' ').trim();
    return (input.value || input.getAttribute('aria-label') || '').trim();
  }

  function clickInput(el) {
    el.click();
    if (el.tagName === 'INPUT') { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  }

  function fillDate(el) {
    const d = new Date(Date.now() + 14 * 86400000); // a safe "soon" default — review before submit
    window.JobPilot.setNativeValue(el, d.toISOString().slice(0, 10));
    window.JobPilot.highlight(el);
  }

  // AI-answer/choose every question on the page (popup "AI-answer questions").
  async function autoAnswerAll() {
    const units = questionUnits();
    let done = 0;
    for (const u of units) {
      try { if (await answerUnit(u)) done++; } catch (_) { /* skip and continue */ }
    }
    return { done, total: units.length };
  }

  // ---- cover letter: generate → minimal PDF → attach to file input --------

  function pageRole() {
    return (document.querySelector('h1, [role="heading"]')?.textContent || document.title || '').trim().slice(0, 140);
  }
  function pageCompany() {
    const og = document.querySelector('meta[property="og:site_name"]')?.content;
    if (og) return og.trim();
    return (location.hostname.replace(/^www\./, '').split('.')[0] || 'the company');
  }

  function findFileInput() {
    const inputs = [...document.querySelectorAll('input[type="file"]')].filter((i) => i.offsetParent !== null);
    if (!inputs.length) return null;
    const pref = inputs.find((i) => /cover|letter/i.test((i.name || '') + (i.id || '') + (deriveQuestion(i) || '')));
    return pref || inputs[0];
  }

  // Tiny dependency-free text PDF (Helvetica, wrapped). Good enough for uploads.
  function textToPdf(text) {
    const lines = [];
    text.replace(/\r/g, '').split('\n').forEach((para) => {
      if (!para.trim()) { lines.push(''); return; }
      let cur = '';
      para.split(/\s+/).forEach((w) => {
        if ((cur + ' ' + w).trim().length > 92) { lines.push(cur.trim()); cur = w; }
        else cur += ' ' + w;
      });
      if (cur.trim()) lines.push(cur.trim());
    });
    const esc = (s) => s.replace(/[^\x20-\x7E]/g, '').replace(/([()\\])/g, '\\$1');
    let body = 'BT /F1 11 Tf 64 760 Td 15 TL\n';
    lines.forEach((l) => { body += `(${esc(l)}) Tj T*\n`; });
    body += 'ET';

    const objs = [
      '<</Type/Catalog/Pages 2 0 R>>',
      '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
      '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
      `<</Length ${body.length}>>\nstream\n${body}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach((off) => { pdf += String(off).padStart(10, '0') + ' 00000 n \n'; });
    pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
    const bytes = new Uint8Array(pdf.length);
    for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
    return new Blob([bytes], { type: 'application/pdf' });
  }

  async function attachCoverLetter() {
    const input = findFileInput();
    const role = pageRole();
    const company = pageCompany();
    const r = await msg('GEN_COVER_LETTER', { company, role, jobText: pageRole() });
    const blob = textToPdf(r.text);
    const name = `CoverLetter_${(company || 'JobPilot').replace(/[^a-z0-9]/gi, '')}.pdf`;
    if (!input) {
      // No upload field on the page — download it so the user can attach manually.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return { attached: false, downloaded: true };
    }
    const file = new File([blob], name, { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    window.JobPilot.highlight(input);
    return { attached: true };
  }

  // ---- bootstrap ----------------------------------------------------------

  // Scan the current page for a job listing and save it (generic pages only —
  // LinkedIn/Naukri/Indeed have their own richer extractors).
  function scanListing() {
    const meta = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || '';
    const title = (document.querySelector('h1')?.textContent
      || meta('meta[property="og:title"]', 'content')
      || document.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const company = (meta('meta[property="og:site_name"]', 'content')
      || location.hostname.replace(/^www\./, '').split('.')[0] || '').trim();
    return { title, company, location: '', url: location.href, sourceSite: location.hostname, raw: null };
  }

  function saveListing() {
    return new Promise((resolve, reject) => {
      const payload = scanListing();
      if (!payload.title) return reject(new Error('No job title found on this page'));
      chrome.runtime.sendMessage({ type: 'SAVE_JOB', payload }, (resp) => {
        if (!resp) return reject(new Error('extension background not reachable'));
        resp.ok ? resolve(resp.data) : reject(new Error(resp.error));
      });
    });
  }

  // Popup-triggered actions (works on any page since this script loads everywhere).
  chrome.runtime.onMessage.addListener((m, _s, sendResponse) => {
    if (m.type === 'AUTO_ANSWER') {
      autoAnswerAll().then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (m.type === 'ATTACH_COVER_LETTER') {
      attachCoverLetter().then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    // Generic save — only when no site-specific filler claimed this page.
    if (m.type === 'SAVE_CURRENT' && !window.__jobpilotHandled) {
      saveListing().then((d) => sendResponse({ ok: true, data: d }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    return false;
  });

  let timer = null;
  function scheduleEnhance() { clearTimeout(timer); timer = setTimeout(enhance, 600); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleEnhance);
  } else { scheduleEnhance(); }
  const obs = new MutationObserver(scheduleEnhance);
  obs.observe(document.documentElement, { childList: true, subtree: true });

  window.JobPilotAssist = { enhance, autoAnswerAll, attachCoverLetter, deriveQuestion, isQuestionField };
})();
