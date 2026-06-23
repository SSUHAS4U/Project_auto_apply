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

  const cleanQ = (s) => (s || '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').replace(/\s*required\s*$/i, '').trim();

  // Find the shared question text for a radio/checkbox group.
  function groupQuestion(group) {
    const first = group[0];
    const fs = first.closest('fieldset');
    if (fs) { const lg = fs.querySelector('legend'); if (lg && cleanQ(lg.textContent).length > 2) return cleanQ(lg.textContent); }
    const optionTexts = new Set(group.map((g) => norm(nativeLabel(g))));
    const box = first.closest('div, li, p, section, fieldset');
    if (box) {
      const heads = box.querySelectorAll('[role="heading"], h1, h2, h3, h4, legend, label, [class*="question" i], [class*="title" i], [class*="label" i]');
      for (const h of heads) {
        const t = cleanQ(h.textContent);
        if (t.length > 3 && !optionTexts.has(norm(t))) return t;
      }
      let prev = box.previousElementSibling;
      for (let i = 0; prev && i < 2; i++, prev = prev.previousElementSibling) {
        const t = cleanQ(prev.textContent);
        if (t.length > 3 && t.length < 200 && !optionTexts.has(norm(t))) return t;
      }
    }
    return deriveQuestion(first);
  }

  // AI-answer/choose every question on the page (popup "AI-answer questions").
  async function autoAnswerAll() {
    const items = [...document.querySelectorAll('[role="listitem"]')].filter((el) => el.offsetParent !== null);
    if (items.length) { // Google / MS Forms
      let done = 0;
      for (const el of items) { try { if (await answerUnit({ container: el, q: unitQuestion(el) })) done++; } catch (_) { /* skip */ } }
      return { done, total: items.length };
    }
    return answerGenericForm();
  }

  // Generic ATS/HTML forms: handle radio groups, checkbox groups, selects and open-ended
  // text questions directly (no fragile container guessing).
  async function answerGenericForm() {
    const smart = window.JobPilotSmart;
    const q = (sel) => (smart ? smart.deepQueryAll(sel) : [...document.querySelectorAll(sel)]);
    const vis = (el) => el.offsetParent !== null && !el.disabled;
    let done = 0, total = 0;

    // 1. radio groups (single choice)
    const radios = q('input[type="radio"]').filter(vis);
    const rGroups = {};
    radios.forEach((r, i) => { (rGroups[r.name || '__r' + i] ||= []).push(r); });
    for (const k of Object.keys(rGroups)) {
      const group = rGroups[k]; if (group.length < 2) continue;
      const question = groupQuestion(group);
      const options = group.map(nativeLabel).filter(Boolean);
      if (!question || options.length < 2) continue;
      total++;
      const r = await msg('ASSIST_CHOOSE', { question, options, multi: false });
      const pick = norm((r.selected || [])[0] || '');
      const el = group.find((g) => norm(nativeLabel(g)) === pick) || (pick && group.find((g) => norm(nativeLabel(g)).includes(pick)));
      if (el) { clickInput(el); window.JobPilot.highlight(el); done++; }
    }

    // 2. checkbox groups (multi)
    const checks = q('input[type="checkbox"]').filter((c) => vis(c) && c.name);
    const cGroups = {};
    checks.forEach((c) => { (cGroups[c.name] ||= []).push(c); });
    for (const k of Object.keys(cGroups)) {
      const group = cGroups[k]; if (group.length < 2) continue;
      const question = groupQuestion(group);
      const options = group.map(nativeLabel).filter(Boolean);
      if (!question) continue;
      total++;
      const r = await msg('ASSIST_CHOOSE', { question, options, multi: true });
      const want = (r.selected || []).map(norm);
      let any = false;
      group.forEach((g) => { if (want.includes(norm(nativeLabel(g))) && !g.checked) { clickInput(g); window.JobPilot.highlight(g); any = true; } });
      if (any) done++;
    }

    // 3. native selects (Yes/No, ratings, etc.)
    for (const sel of q('select').filter(vis)) {
      const cur = (sel.options[sel.selectedIndex]?.text || '').trim().toLowerCase();
      if (cur && !/^(select|choose|—|-|please)/.test(cur)) continue;
      const question = deriveQuestion(sel);
      const options = [...sel.options].map((o) => o.text.trim()).filter((t) => t && !/^(select|choose|please)/i.test(t));
      if (!question || options.length < 2) continue;
      total++;
      const r = await msg('ASSIST_CHOOSE', { question, options, multi: false });
      const pick = norm((r.selected || [])[0] || '');
      const opt = [...sel.options].find((o) => norm(o.text) === pick) || (pick && [...sel.options].find((o) => norm(o.text).includes(pick)));
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); window.JobPilot.highlight(sel); done++; }
    }

    // 4. open-ended text / paragraph questions
    for (const el of q('textarea, input[type="text"], input:not([type]), [contenteditable="true"]').filter((e) => vis(e) && !e.readOnly)) {
      if (readValue(el).trim()) continue;
      const question = deriveQuestion(el);
      const isPara = el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true';
      if (!question || (!isPara && !looksLikeQuestion(question))) continue;
      total++;
      const r = await msg('ASSIST_ANSWER', { question });
      if (r && r.answer) { writeValue(el, r.answer); window.JobPilot.highlight(el); done++; }
    }

    return { done, total };
  }

  // ---- cover letter: generate → minimal PDF → attach to file input --------

  function pageRole() {
    return (document.querySelector('h1, [role="heading"]')?.textContent || document.title || '').trim().slice(0, 140);
  }
  function pageCompany() {
    const og = document.querySelector('meta[property="og:site_name"]')?.content;
    if (og) return og.trim();
    const ats = document.querySelector('[data-automation-id="company"], [class*="company" i]')?.textContent;
    if (ats && ats.trim().length < 60) return ats.trim();
    return (location.hostname.replace(/^www\./, '').split('.')[0] || 'the company');
  }
  // The job description text on the page, so the AI can tailor the letter.
  function extractJobText() {
    const main = document.querySelector('[class*="job-description" i], [class*="description" i], [data-automation-id="jobPostingDescription"], main, article, [role="main"]') || document.body;
    return (main.innerText || main.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2800);
  }

  // All file inputs incl. hidden ones (upload widgets often hide the real <input>
  // behind a styled button) and those inside open shadow roots.
  function allFileInputs() {
    const smart = window.JobPilotSmart;
    const els = smart ? smart.deepQueryAll('input[type="file"]') : [...document.querySelectorAll('input[type="file"]')];
    return els.filter((i) => !i.disabled);
  }

  // Text around a file input — name/id/aria, its derived label, and its wrapper text.
  function fileInputContext(i) {
    let txt = `${i.name || ''} ${i.id || ''} ${i.getAttribute('aria-label') || ''} ${deriveQuestion(i) || ''}`;
    const box = i.closest('div, section, fieldset, li, form');
    if (box) txt += ' ' + (box.textContent || '').slice(0, 140);
    return txt.toLowerCase();
  }

  // Pick the right upload slot for a kind ('resume' | 'cover'), avoiding the other kind's slot.
  function findFileInput(kind) {
    const inputs = allFileInputs();
    if (!inputs.length) return null;
    const want = kind === 'cover' ? /cover|letter|motivation/i
      : kind === 'resume' ? /resume|cv|curriculum|biodata|résumé/i : null;
    if (want) { const m = inputs.find((i) => want.test(fileInputContext(i))); if (m) return m; }
    const other = kind === 'cover' ? /resume|cv|curriculum/i : kind === 'resume' ? /cover|letter|motivation/i : null;
    const neutral = other ? inputs.find((i) => !other.test(fileInputContext(i))) : null;
    return neutral || inputs[0];
  }

  function attachFileToInput(input, blob, name) {
    const file = new File([blob], name, { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    try { window.JobPilot.highlight(input.offsetParent ? input : (input.closest('div, label') || input)); } catch (_) { /* ignore */ }
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
    const role = pageRole();
    const company = pageCompany();
    const r = await msg('GEN_COVER_LETTER', { company, role, jobText: extractJobText() });
    if (!r || !r.text) throw new Error('Could not generate a cover letter');
    const blob = textToPdf(r.text);
    const name = `CoverLetter_${(company || 'JobPilot').replace(/[^a-z0-9]/gi, '')}.pdf`;
    const input = findFileInput('cover');
    if (!input) {
      // No upload field on the page — download it so the user can attach manually.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return { attached: false, downloaded: true, role, company };
    }
    attachFileToInput(input, blob, name);
    return { attached: true, role, company };
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

  const isCombobox = (el) =>
    el.getAttribute('role') === 'combobox'
    || el.getAttribute('aria-autocomplete')
    || el.getAttribute('aria-haspopup') === 'listbox';

  // Comprehensive AI fill: text inputs, native <select>, AND custom dropdowns the
  // synonym engine can't touch. Sends each field's label to the backend (which maps it
  // to the profile), then fills by control type. Searches inside open Shadow DOM.
  async function aiFillFields() {
    const smart = window.JobPilotSmart;
    const q = (sel) => (smart ? smart.deepQueryAll(sel) : [...document.querySelectorAll(sel)]);
    const candidates = [];

    // 1. text-like inputs + textareas
    q('input, textarea').forEach((el) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (el.tagName === 'INPUT' && !['text', 'url', 'tel', 'email', 'number', 'search', ''].includes(type)) return;
      if (el.disabled || el.readOnly || el.offsetParent === null) return;
      if ((el.value || '').trim()) return;
      const label = deriveQuestion(el);
      if (label && label.length >= 2) candidates.push({ el, label, kind: (smart && (smart.isCustomDropdown(el) || isCombobox(el))) ? 'combo' : 'text' });
    });
    // 2. native selects (still on default/empty option)
    q('select').forEach((el) => {
      if (el.disabled || el.offsetParent === null) return;
      const cur = (el.options[el.selectedIndex]?.text || '').trim().toLowerCase();
      if (cur && !/^(select|choose|—|-|please select)/.test(cur)) return;
      const label = deriveQuestion(el);
      if (label && label.length >= 2) candidates.push({ el, label, kind: 'select' });
    });
    // 3. custom dropdown triggers (div/button widgets)
    if (smart) {
      q('[role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [class*="select__control" i], [class*="dropdown" i][role]').forEach((el) => {
        if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.offsetParent === null) return;
        if (!smart.isCustomDropdown(el)) return;
        const label = deriveQuestion(el);
        if (label && label.length >= 2 && !candidates.some((c) => c.el === el)) candidates.push({ el, label, kind: 'custom' });
      });
    }

    if (!candidates.length) return { filled: 0, total: 0 };
    const labels = [...new Set(candidates.map((c) => c.label))];
    const r = await msg('ASSIST_AUTOFILL', { fields: labels });
    const answers = (r && r.answers) || {};

    let filled = 0;
    for (const { el, label, kind } of candidates) {
      const v = answers[label];
      if (!v || !String(v).trim()) continue;
      try {
        if (kind === 'select') {
          const want = norm(v);
          const opt = [...el.options].find((o) => norm(o.text) === want) || [...el.options].find((o) => norm(o.text).includes(want));
          if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); window.JobPilot.highlight(el); filled++; }
        } else if (kind === 'custom') {
          if (await smart.fillCustomDropdown(el, String(v))) { window.JobPilot.highlight(el); filled++; }
        } else if (kind === 'combo') {
          if ((el.value || '').trim()) continue;
          if (await smart.fillTypeahead(el, String(v))) { window.JobPilot.highlight(el); filled++; }
        } else {
          if ((el.value || '').trim()) continue;
          writeValue(el, String(v)); filled++;
        }
        if (smart) await smart.sleep(120);
      } catch (_) { /* keep going */ }
    }
    return { filled, total: candidates.length };
  }

  // Attach the user's stored resume to the page's file-upload field.
  async function uploadResume() {
    const r = await msg('GET_RESUME');
    if (!r || !r.hasResume) throw new Error('No resume on file — upload one in your JobPilot profile first');
    const input = findFileInput('resume');
    if (!input) throw new Error('No file-upload field found on this page');
    const bytes = Uint8Array.from(atob(r.contentBase64), (c) => c.charCodeAt(0));
    const type = r.contentType || 'application/pdf';
    const blob = new Blob([bytes], { type });
    attachFileToInput(input, blob, r.filename || 'resume.pdf');
    return { attached: true, filename: r.filename };
  }

  // Popup-triggered actions (works on any page since this script loads everywhere).
  chrome.runtime.onMessage.addListener((m, _s, sendResponse) => {
    if (m.type === 'AUTO_ANSWER') {
      autoAnswerAll().then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (m.type === 'AI_FILL') {
      aiFillFields().then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (m.type === 'UPLOAD_RESUME') {
      uploadResume().then((r) => sendResponse({ ok: true, ...r }))
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
    // Side-panel chatbot: report the page's fields, or fill one by label.
    if (m.type === 'SCAN_FIELDS') {
      sendResponse({ ok: true, fields: scanFields() });
      return true;
    }
    if (m.type === 'FILL_FIELD') {
      fillFieldByLabel(m.label, m.value).then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    return false;
  });

  // --- Field discovery + targeted fill (for the side-panel copilot) ---------
  function allFillable() {
    const smart = window.JobPilotSmart;
    const els = smart ? smart.deepQueryAll('input, textarea, select') : [...document.querySelectorAll('input, textarea, select')];
    return els.filter((el) => {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(t)) return false;
      return el.offsetParent !== null && !el.disabled;
    });
  }

  function scanFields() {
    const out = [];
    allFillable().forEach((el) => { const l = deriveQuestion(el); if (l && l.length >= 2) out.push(l); });
    return [...new Set(out)];
  }

  function allTargets() {
    const smart = window.JobPilotSmart;
    const sel = 'input, textarea, select, [role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [class*="select__control" i]';
    const els = smart ? smart.deepQueryAll(sel) : [...document.querySelectorAll(sel)];
    return els.filter((el) => {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(t)) return false;
      return el.offsetParent !== null && !el.disabled;
    });
  }

  async function fillFieldByLabel(label, value) {
    const want = norm(label);
    let best = null, bestScore = 0;
    allTargets().forEach((el) => {
      const l = norm(deriveQuestion(el));
      if (!l) return;
      let score = 0;
      if (l === want) score = 1000;
      else if (l.includes(want)) score = want.length + 5;
      else if (want.includes(l)) score = l.length;
      if (score > bestScore) { bestScore = score; best = el; }
    });
    if (!best) return { ok: false, error: `No field matching "${label}" on this page.` };
    const smart = window.JobPilotSmart;
    if (best.tagName === 'SELECT') {
      const opt = [...best.options].find((o) => norm(o.text) === norm(value)) || [...best.options].find((o) => norm(o.text).includes(norm(value)));
      if (opt) { best.value = opt.value; best.dispatchEvent(new Event('change', { bubbles: true })); }
    } else if (smart && smart.isCustomDropdown(best)) {
      await smart.fillCustomDropdown(best, String(value));
    } else if (smart && isCombobox(best)) {
      await smart.fillTypeahead(best, String(value));
    } else {
      writeValue(best, String(value));
    }
    window.JobPilot.highlight(best);
    return { ok: true, label: deriveQuestion(best) };
  }

  let timer = null;
  function scheduleEnhance() { clearTimeout(timer); timer = setTimeout(enhance, 600); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleEnhance);
  } else { scheduleEnhance(); }
  const obs = new MutationObserver(scheduleEnhance);
  obs.observe(document.documentElement, { childList: true, subtree: true });

  window.JobPilotAssist = { enhance, autoAnswerAll, attachCoverLetter, deriveQuestion, isQuestionField };
})();
