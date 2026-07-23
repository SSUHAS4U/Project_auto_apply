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

  // Machine names that are NOT human labels ("field_9702_1_1", "q17", raw hashes…).
  const JUNK_NAME = /^(field|input|q|question|item|el|ctrl|control|answer)[_\-]?\d|^\d+$|^[a-z]?\d[\d_\-]*$|^[a-z0-9]{16,}$/i;

  // Nearest heading-ish text physically above a node (section titles like
  // "10TH ACADEMIC DETAILS" that grids rely on instead of per-field labels).
  function nearestHeading(node) {
    let cur = node;
    for (let d = 0; cur && cur !== document.body && d < 5; d++, cur = cur.parentElement) {
      let sib = cur.previousElementSibling;
      for (let i = 0; sib && i < 4; i++, sib = sib.previousElementSibling) {
        const t = (sib.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 2 && t.length < 90
            && (/^H[1-6]$/.test(sib.tagName)
              || sib.matches('legend, [role="heading"], [class*="head" i], [class*="title" i], [class*="section" i], b, strong')
              || sib.children.length === 0)) return t;
      }
    }
    return '';
  }

  // Table grids (HCL-style ATS wizards): the label lives in the COLUMN header <th>,
  // the row header cell, and the section heading above the table — not on the input.
  function tableLabel(el) {
    const td = el.closest && el.closest('td, th');
    const table = el.closest && el.closest('table');
    if (!td || !table) return '';
    const tr = td.parentElement;
    const idx = [...tr.children].indexOf(td);
    let headRow = table.tHead && table.tHead.rows.length ? table.tHead.rows[table.tHead.rows.length - 1] : null;
    if (!headRow) {
      for (const r of table.rows) { if (r !== tr && r.querySelector('th')) { headRow = r; break; } }
    }
    const cell = (c) => (c ? (c.textContent || '').replace(/\s+/g, ' ').replace(/\*\s*$/, '').trim() : '');
    const col = headRow ? cell(headRow.children[idx]) : '';
    const first = tr.children[0];
    const row = first && first !== td && !first.querySelector('input,select,textarea') ? cell(first) : '';
    if (!col && !row) return '';
    const sect = nearestHeading(table);
    return [sect, row, col].filter((t) => t && t.length < 90).join(' — ');
  }

  // The text physically before a field on the page — usually its question.
  function beforeText(el) {
    let txt = '';
    let cur = el;
    for (let d = 0; cur && d < 4 && txt.length < 150; d++, cur = cur.parentElement) {
      let sib = cur.previousElementSibling;
      for (let i = 0; sib && i < 3 && txt.length < 150; i++, sib = sib.previousElementSibling) {
        const t = (sib.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) txt = t.slice(-150) + (txt ? ' | ' + txt : '');
      }
    }
    return txt.trim();
  }

  // Raw context for the AI labeler: attributes + grid headers + preceding page text.
  function fieldContext(el) {
    if (!el) return '';
    const parts = [];
    const attr = (n) => (el.getAttribute ? el.getAttribute(n) : null);
    if (attr('name')) parts.push('name=' + attr('name'));
    if (attr('id')) parts.push('id=' + attr('id'));
    if (attr('placeholder')) parts.push('placeholder=' + attr('placeholder'));
    if (el.tagName === 'SELECT') {
      const opts = [...el.options].slice(0, 6).map((o) => o.text.trim()).filter(Boolean);
      if (opts.length) parts.push('options=' + opts.join('/'));
    }
    const tl = tableLabel(el);
    if (tl) parts.push('table=' + tl);
    const txt = beforeText(el);
    if (txt) parts.push('before="' + txt.slice(0, 200) + '"');
    return parts.join('; ').slice(0, 420);
  }

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
    // 4.5 Table grids: column header + row + section (must beat the container scan —
    //     a <div> above the table would give EVERY cell the same section heading).
    const tl = tableLabel(el);
    if (tl) return strip(tl).slice(0, 500);
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
    // A machine name ("field_9702_1_1") is worse than no label — the AI labeler
    // reads the field's surroundings instead.
    const nm = clean(el.name || '');
    return JUNK_NAME.test(nm) ? '' : nm;
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

  // ---- focus pill (✨ AI answer · 💾 save) ----------------------------------
  // Instead of littering every field with permanent buttons, ONE compact pill
  // appears next to the question field you're focused on, and vanishes on blur.

  let pill = null;
  let pillField = null;
  let pillHideTimer = null;

  function buildPill() {
    if (pill) return pill;
    pill = document.createElement('div');
    pill.id = 'jobpilot-pill';
    pill.style.cssText = [
      'position:absolute', 'z-index:2147483647', 'display:flex', 'align-items:center', 'gap:2px',
      'padding:3px', 'border-radius:999px', 'background:rgba(17,20,29,.92)',
      'backdrop-filter:blur(8px)', 'border:1px solid rgba(99,102,241,.45)',
      'box-shadow:0 6px 24px rgba(0,0,0,.35)', 'font:600 12px system-ui,sans-serif',
      'transition:opacity .12s ease', 'opacity:0',
    ].join(';');

    const mk = (label, title) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.title = title;
      b.style.cssText = [
        'border:none', 'border-radius:999px', 'padding:5px 11px', 'cursor:pointer',
        'color:#e7e9ee', 'background:transparent', 'font:600 12px system-ui,sans-serif',
        'transition:background .12s',
      ].join(';');
      b.addEventListener('mouseenter', () => { b.style.background = 'rgba(99,102,241,.35)'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep field focus
      return b;
    };

    const ai = mk('✨ AI answer', 'Generate an answer from your profile');
    const save = mk('💾 Save', 'Save this Q&A for autofill');
    const note = document.createElement('span');
    note.style.cssText = 'color:#9aa1b1;font-weight:500;padding:0 8px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    // Always act on the field that is focused RIGHT NOW (mousedown preventDefault
    // keeps it focused) — never a stale reference from an earlier focus.
    const currentField = () => {
      const a = document.activeElement;
      if (a && a !== document.body && isPillTarget(a)) return a;
      return pillField;
    };

    ai.addEventListener('click', async () => {
      const el = currentField();
      if (!el) return;
      ai.disabled = true; const old = ai.textContent; ai.textContent = '✨ thinking…';
      try {
        note.title = '';
        await answerIntoField(el, note);
      } catch (e) {
        note.textContent = '⚠ ' + e.message;
        note.title = e.message + ' — click ✨ to retry'; // full text on hover (note truncates)
      } finally { ai.disabled = false; ai.textContent = old; }
    });

    save.addEventListener('click', async () => {
      const el = currentField();
      if (!el) return;
      const question = deriveQuestion(el);
      const answer = readValue(el).trim();
      if (!question) { note.textContent = 'no question detected'; return; }
      if (!answer) { note.textContent = 'type an answer first'; return; }
      save.disabled = true;
      try { await msg('SAVE_QA', { question, answer }); note.textContent = '✓ saved'; }
      catch (e) { note.textContent = '⚠ ' + e.message; }
      finally { save.disabled = false; }
    });

    // Keep the pill alive while the pointer is over it. (No hide on mouseleave —
    // the pill lives by FIELD focus, not cursor position; leaving it mid-drag or
    // while reading must not dismiss it.)
    pill.addEventListener('mouseenter', () => clearTimeout(pillHideTimer));

    // Drag handle: grab the ⠿ grip (or the note area) and park the pill anywhere it
    // doesn't cover the form. The manual position sticks until the pill hides.
    const grip = document.createElement('span');
    grip.textContent = '⠿';
    grip.title = 'Drag to move';
    grip.style.cssText = 'cursor:grab;color:#6b7280;padding:0 4px 0 8px;font-size:12px;user-select:none';
    const startDrag = (e) => {
      e.preventDefault();
      const pr = pill.getBoundingClientRect();
      const dx = e.clientX - pr.left, dy = e.clientY - pr.top;
      const onMove = (ev) => {
        pillDragged = true;
        pillPinned = true; // moving it means "keep it around" — only ✕ / Esc dismiss it
        pill.style.left = Math.max(4, ev.clientX - dx + window.scrollX) + 'px';
        pill.style.top = Math.max(4, ev.clientY - dy + window.scrollY) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    grip.addEventListener('mousedown', startDrag);
    note.addEventListener('mousedown', startDrag);

    const close = document.createElement('button');
    close.textContent = '✕';
    close.title = 'Close (Esc)';
    close.style.cssText = 'border:none;background:transparent;color:#9aa1b1;cursor:pointer;padding:4px 8px;font-size:12px;border-radius:999px';
    close.addEventListener('mousedown', (e) => e.preventDefault());
    close.addEventListener('click', () => { pillSuppressed = true; hidePill(true); });

    pill.append(grip, ai, save, note, close);
    pill._note = note;
    document.body.appendChild(pill);
    return pill;
  }

  let pillDragged = false;
  let pillPinned = false;
  let pillSuppressed = false; // ✕ dismisses the pill for the rest of this page (until reload)

  // Type-aware AI answer for the focused field: selects choose among their REAL
  // options; custom dropdowns/typeaheads get a short value picked into the widget;
  // date/tel/url/email/number fields get the literal profile fact in the right
  // format; only true open questions get prose.
  async function answerIntoField(el, note) {
    const question = deriveQuestion(el);
    if (!question) { note.textContent = 'no question detected'; return; }
    const smart = window.JobPilotSmart;

    if (el.tagName === 'SELECT') {
      const options = [...el.options].map((o) => o.text.trim()).filter((t) => t && !/^(select|choose|please)/i.test(t));
      if (!options.length) { note.textContent = 'no options in this dropdown'; return; }
      const r = await msg('ASSIST_CHOOSE', { question, options, multi: false });
      const pick = norm(((r && r.selected) || [])[0] || '');
      const opt = [...el.options].find((o) => norm(o.text) === pick)
        || (pick && [...el.options].find((o) => norm(o.text).includes(pick) || pick.includes(norm(o.text))));
      if (!opt) { note.textContent = 'no option matched'; return; }
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      window.JobPilot.highlight(el);
      note.textContent = '✓ ' + opt.text.trim().slice(0, 26);
      return;
    }

    const type = el.tagName === 'INPUT'
      ? (el.getAttribute('type') || 'text').toLowerCase()
      : (el.tagName === 'TEXTAREA' ? 'textarea' : 'text');
    const isDrop = el.tagName === 'INPUT' && smart && (smart.isCustomDropdown(el) || isCombobox(el));

    const r = await msg('ASSIST_ANSWER', { question, fieldType: isDrop ? 'dropdown' : type });
    const answer = r && r.answer;
    if (!answer || !String(answer).trim()) { note.textContent = 'nothing in your profile for this'; return; }

    if (isDrop) {
      const ok = smart.isCustomDropdown(el)
        ? await smart.fillCustomDropdown(el, String(answer))
        : await smart.fillTypeahead(el, String(answer));
      if (!ok) writeValue(el, String(answer)); // fall back to typing the value
    } else {
      writeValue(el, String(answer));
    }
    window.JobPilot.highlight(el);
    note.textContent = r.source === 'saved' ? '↺ saved answer'
      : r.source === 'profile' ? '👤 from profile' : '✓ AI';
  }

  // Everything the pill can act on — question fields PLUS selects, custom dropdowns
  // and value-typed inputs (date / tel / url / email / number) that have a label.
  function isPillTarget(el) {
    if (!el || el.disabled || el.offsetParent === null) return false;
    if (pillSuppressed) return false;               // user dismissed it for this page
    if (el.tagName === 'SELECT') return true;
    // Only REAL questions get the focus pill now — a textarea, a contenteditable box, or a
    // text input whose label reads like a question. Short factual fields (name, email, phone,
    // city) no longer trigger it, which is what made it feel like it popped up everywhere.
    // Bulk filling of those still happens via "Scan & review, then fill".
    return isQuestionField(el);
  }

  function showPillFor(el) {
    const p = buildPill();
    pillField = el;
    p._note.textContent = '';
    p.style.display = 'flex';
    if (!pillDragged) {
      // To the RIGHT of the field, vertically centered on it — clear of the label
      // above and the value inside. Falls back to below-left when the field spans
      // the full width and there's no room on the right.
      const r = el.getBoundingClientRect();
      const pw = p.offsetWidth || 270;
      const ph = p.offsetHeight || 38;
      if (r.right + 10 + pw <= window.innerWidth) {
        p.style.top = (window.scrollY + Math.max(4, r.top + (r.height - ph) / 2)) + 'px';
        p.style.left = (window.scrollX + r.right + 10) + 'px';
      } else {
        const fitsBelow = r.bottom + ph + 10 < window.innerHeight;
        p.style.top = (window.scrollY + (fitsBelow ? r.bottom + 8 : Math.max(4, r.top - ph - 6))) + 'px';
        p.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - pw - 8)) + 'px';
      }
    }
    requestAnimationFrame(() => { p.style.opacity = '1'; });
  }

  function hidePill(force) {
    if (!pill) return;
    if (!force) {
      // Pinned (user dragged it) → only ✕ / Esc dismiss it.
      if (pillPinned) return;
      // Focus merely moved into the pill or onto another fillable field → keep it.
      const a = document.activeElement;
      if (a && pill.contains(a)) return;
      if (a && a !== document.body && isPillTarget(a)) { pillField = a; return; }
    }
    pill.style.opacity = '0';
    pillField = null;
    pillPinned = false;
    pillDragged = false; // next field gets automatic placement again
    setTimeout(() => { if (pill && !pillField) pill.style.display = 'none'; }, 130);
  }

  function scheduleHidePill() {
    clearTimeout(pillHideTimer);
    pillHideTimer = setTimeout(hidePill, 220);
  }

  function installPill() {
    if (document.__jobpilotPillInstalled) return;
    document.__jobpilotPillInstalled = true;
    document.addEventListener('focusin', (e) => {
      if (window.JobPilot && !window.JobPilot.isEnabled()) return;
      if (!looksLikeApplicationForm()) return;
      const el = e.target;
      clearTimeout(pillHideTimer);
      if (isPillTarget(el)) showPillFor(el);
      else if (!pill || !pill.contains(el)) scheduleHidePill();
    });
    document.addEventListener('focusout', scheduleHidePill);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePill(true); });
    window.addEventListener('scroll', () => { if (pillField) showPillFor(pillField); }, { passive: true });
  }

  // Sites that are clearly NOT job applications — never inject the ✨/Save buttons here.
  const DENY_HOSTS = /(^|\.)(chat\.openai|chatgpt|claude\.ai|gemini\.google|bard\.google|copilot\.microsoft|bing|perplexity|you|poe|phind|google|duckduckgo|youtube|x|twitter|facebook|instagram|reddit|whatsapp|telegram|discord|slack|notion|figma|stackoverflow|github|gitlab)\.com/i;
  // Sites that ARE application/recruiting forms — always allow.
  const ALLOW_HOSTS = /(greenhouse\.io|lever\.co|ashbyhq\.com|myworkday|workday|icims\.com|smartrecruiters|bamboohr|taleo|successfactors|jobvite|workable|recruitee|teamtailor|breezy\.hr|naukri\.com|indeed\.com|linkedin\.com|wellfound\.com|instahyre|hirist|cutshort|forms\.office\.com|forms\.gle|docs\.google\.com|careers\.microsoft\.com|careers\.google\.com|phenompeople|phenom\.com|eightfold\.ai|avature\.net|oraclecloud\.com|darwinbox|zohorecruit|keka\.com|ripplehire|turbohire|jobs\.siemens|jobs\.sap|hcltech\.com|freshers\.)/i;

  function looksLikeApplicationForm() {
    const host = location.hostname;
    if (ALLOW_HOSTS.test(host)) return true;
    if (DENY_HOSTS.test(host)) return false;
    // Generic page: only treat it as an application if the URL/title says so AND it has a form.
    const hay = (location.href + ' ' + document.title).toLowerCase();
    const jobby = /(apply|application|career|job|recruit|vacancy|opening|hiring|candidate|position|fresher|placement)/.test(hay);
    const hasUpload = !!document.querySelector('input[type="file"]');
    const fields = document.querySelectorAll('form textarea, form input[type="text"], form input[type="email"], [role="listitem"]').length;
    return (jobby && (hasUpload || fields >= 3));
  }

  // The pill is delegated (focusin), so a one-time install covers dynamic forms too.
  function enhance() {
    installPill();
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

  // Click an ARIA radio/option widget (no native input behind it).
  function clickOption(el) {
    try { el.scrollIntoView({ block: 'nearest' }); } catch (_) { /* ignore */ }
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.click();
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    try { el.setAttribute('aria-checked', 'true'); } catch (_) { /* ignore */ }
  }

  // Question text for an ARIA radiogroup: aria-label/labelledby, else the nearest
  // question-looking heading/sibling above the group (excluding the option labels).
  function ariaGroupQuestion(rg) {
    const byLabel = rg.getAttribute('aria-label');
    if (byLabel && cleanQ(byLabel).length > 2) return cleanQ(byLabel);
    const lblId = rg.getAttribute('aria-labelledby');
    if (lblId) {
      const txt = lblId.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (cleanQ(txt).length > 2) return cleanQ(txt);
    }
    const optTexts = new Set([...rg.querySelectorAll('[role="radio"]')].map((o) => norm(labelOf(o))));
    let node = rg;
    for (let up = 0; up < 4 && node; up++, node = node.parentElement) {
      let prev = node.previousElementSibling;
      for (let i = 0; prev && i < 3; i++, prev = prev.previousElementSibling) {
        const t = cleanQ(prev.textContent);
        if (t.length > 5 && t.length < 300 && !optTexts.has(norm(t))) return t;
      }
    }
    const box = rg.closest('fieldset, [role="group"], li, div, section');
    if (box) {
      const heads = box.querySelectorAll('legend, [role="heading"], h1, h2, h3, h4, label, [class*="question" i], [class*="label" i]');
      for (const h of heads) { const t = cleanQ(h.textContent); if (t.length > 3 && !optTexts.has(norm(t))) return t; }
    }
    return cleanQ(rg.textContent);
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

    // 1b. ARIA radio groups (custom radio widgets — Workday, Microsoft, etc.)
    for (const rg of q('[role="radiogroup"]').filter(vis)) {
      const opts = [...rg.querySelectorAll('[role="radio"]')].filter((o) => o.offsetParent !== null);
      if (opts.length < 2) continue;
      if (opts.some((o) => o.getAttribute('aria-checked') === 'true')) continue; // already answered
      const question = ariaGroupQuestion(rg);
      const options = opts.map((o) => labelOf(o)).filter(Boolean);
      if (!question || options.length < 2) continue;
      total++;
      const r = await msg('ASSIST_CHOOSE', { question, options, multi: false });
      const pick = norm((r.selected || [])[0] || '');
      const el = opts.find((o) => norm(labelOf(o)) === pick) || (pick && opts.find((o) => norm(labelOf(o)).includes(pick)));
      if (el) { clickOption(el); window.JobPilot.highlight(el); done++; }
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

  // ---- plan & review fill ----------------------------------------------------
  // PLAN_FILL scans every empty fillable field, computes a proposed answer for each
  // (profile mapping → AI option choice → AI free answer) and returns the plan WITHOUT
  // touching the page. The side panel shows it for review/editing; APPLY_FILL then
  // writes the (possibly edited) values.

  let planRegistry = []; // id → { kind, el?, els? } — valid until the page changes

  async function planFill() {
    const smart = window.JobPilotSmart;
    const q = (sel) => (smart ? smart.deepQueryAll(sel) : [...document.querySelectorAll(sel)]);
    // checkVisibility sees through CSS visibility/opacity tricks that multi-step
    // wizards use — offsetParent alone let hidden steps leak into the plan.
    const shown = (el) => (el.checkVisibility
      ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : el.offsetParent !== null);
    const vis = (el) => shown(el) && !el.disabled;
    planRegistry = [];
    let units = [];
    const seen = new Set();
    // Fields without a readable label are KEPT (keyed by their machine name) — the
    // AI labeler names them from their surroundings in a later pass.
    const push = (u) => {
      const key = norm(u.label || (u.el && (u.el.name || u.el.id)) || ('anon' + units.length));
      if (seen.has(key) || units.length >= 40) return;
      seen.add(key);
      u.id = units.length;
      units.push(u);
    };

    // text-like inputs / textareas / custom dropdown triggers (empty only)
    q('input, textarea').forEach((el) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (el.tagName === 'INPUT' && !['text', 'url', 'tel', 'email', 'number', 'search', ''].includes(type)) return;
      if (!vis(el) || el.readOnly || (el.value || '').trim()) return;
      const label = deriveQuestion(el);
      const isPara = el.tagName === 'TEXTAREA';
      const combo = smart && (smart.isCustomDropdown(el) || isCombobox(el));
      push({ el, label, kind: combo ? 'combo' : (isPara || looksLikeQuestion(label || '') ? 'question' : 'text') });
    });
    q('select').forEach((el) => {
      if (!vis(el)) return;
      const cur = (el.options[el.selectedIndex]?.text || '').trim().toLowerCase();
      if (cur && !/^(select|choose|—|-|please)/.test(cur)) return;
      const label = deriveQuestion(el);
      const options = [...el.options].map((o) => o.text.trim()).filter((t) => t && !/^(select|choose|please)/i.test(t));
      if (options.length < 2) return;
      push({ el, label, kind: 'select', options });
    });
    // Custom dropdown TRIGGERS — the button/div widgets real ATSs use (Workday
    // aria-haspopup buttons, react-select controls, MUI role=combobox divs…).
    q('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], [class*="select__control" i], [data-automation-id*="select" i], [data-automation-id*="dropdown" i]')
      .forEach((el) => {
        if (['SELECT', 'OPTION', 'INPUT', 'TEXTAREA'].includes(el.tagName)) return; // inputs handled above
        if (!shown(el) || el.closest('[role="listbox"], [role="option"]')) return;
        const already = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const label = deriveQuestion(el); // may be '' — the labeler passes name it later
        // Skip widgets that clearly hold a chosen value already ("Select One" ≠ chosen).
        if (already && label && norm(already) !== norm(label)
            && !/select|choose|please|—|^-$|search/i.test(already) && already.length < 60 && !already.includes(label)) return;
        push({ el, label, kind: 'custom' });
      });
    // native radio groups
    const rGroups = {};
    q('input[type="radio"]').filter(vis).forEach((r, i) => { (rGroups[r.name || '__r' + i] ||= []).push(r); });
    for (const k of Object.keys(rGroups)) {
      const group = rGroups[k];
      if (group.length < 2 || group.some((g) => g.checked)) continue;
      const label = groupQuestion(group);
      const options = group.map(nativeLabel).filter(Boolean);
      if (!label || options.length < 2 || seen.has(norm(label))) continue;
      seen.add(norm(label));
      push({ els: group, label, kind: 'radio', options });
    }
    // ARIA radio groups — grouped by their CONTAINER, not by a [role=radiogroup] wrapper.
    // Google Forms (and some Workday/MS layouts) don't always put role=radiogroup on the
    // group, so requiring it made every radio question invisible — the core "it never fills
    // radios" bug. Instead we collect every visible [role=radio] and bucket it by the nearest
    // question container (radiogroup → Forms listitem → group/fieldset → parent).
    const ariaGroupsByHolder = new Map();
    for (const o of q('[role="radio"]').filter(shown)) {
      const holder = o.closest('[role="radiogroup"]')
        || o.closest('[role="listitem"], [data-params], [jsmodel], fieldset, [role="group"]')
        || o.parentElement;
      if (!holder) continue;
      if (!ariaGroupsByHolder.has(holder)) ariaGroupsByHolder.set(holder, []);
      ariaGroupsByHolder.get(holder).push(o);
    }
    for (const [holder, opts] of ariaGroupsByHolder) {
      if (opts.length < 2 || opts.some((o) => o.getAttribute('aria-checked') === 'true')) continue;
      const label = ariaGroupQuestion(holder);
      const options = opts.map((o) => labelOf(o)).filter(Boolean);
      if (!label || options.length < 2 || seen.has(norm(label))) continue;
      seen.add(norm(label));
      push({ els: opts, label, kind: 'aria-radio', options });
    }
    // native checkbox groups (multi)
    const cGroups = {};
    q('input[type="checkbox"]').filter((c) => vis(c) && c.name).forEach((c) => { (cGroups[c.name] ||= []).push(c); });
    for (const k of Object.keys(cGroups)) {
      const group = cGroups[k];
      if (group.length < 2 || group.some((g) => g.checked)) continue;
      const label = groupQuestion(group);
      const options = group.map(nativeLabel).filter(Boolean);
      if (!label || !options.length || seen.has(norm(label))) continue;
      seen.add(norm(label));
      push({ els: group, label, kind: 'checkbox', options });
    }
    // ARIA checkbox groups (Google Forms multi-select) — same container grouping as radios.
    const ariaCbByHolder = new Map();
    for (const o of q('[role="checkbox"]').filter(shown)) {
      const holder = o.closest('[role="group"], [role="listitem"], [data-params], [jsmodel], fieldset') || o.parentElement;
      if (!holder) continue;
      if (!ariaCbByHolder.has(holder)) ariaCbByHolder.set(holder, []);
      ariaCbByHolder.get(holder).push(o);
    }
    for (const [holder, opts] of ariaCbByHolder) {
      if (opts.length < 2 || opts.some((o) => o.getAttribute('aria-checked') === 'true')) continue;
      const label = ariaGroupQuestion(holder);
      const options = opts.map((o) => labelOf(o)).filter(Boolean);
      if (!label || options.length < 2 || seen.has(norm(label))) continue;
      seen.add(norm(label));
      push({ els: opts, label, kind: 'aria-checkbox', options });
    }

    if (!units.length) return { plan: [] };

    // AI labeler: any field the DOM couldn't explain (grids, exotic markup) gets
    // named by the AI from its raw surroundings — like a human reading the page.
    const unnamed = units.filter((u) => !u.label || u.label.length < 3 || JUNK_NAME.test(u.label));
    if (unnamed.length) {
      try {
        const ctx = unnamed.map((u) => ({ key: String(u.id), context: fieldContext(u.el || (u.els && u.els[0])) }));
        const named = await msg('ASSIST_LABELS', { fields: ctx });
        const map = (named && named.labels) || {};
        unnamed.forEach((u) => { const v = map[String(u.id)]; if (v && v.length > 2) u.label = v; });
      } catch (_) { /* fields stay unnamed and are dropped below */ }
    }
    // Never drop a field just because naming failed: fall back to the text right
    // before it on the page (usually the question itself). And bare generic labels
    // ("Month", "Day", "Year") get their question prefixed for clarity.
    units.forEach((u) => {
      const el = u.el || (u.els && u.els[0]);
      if (!el) return;
      if (!u.label || u.label.length < 3) {
        const before = beforeText(el).split('|').pop().trim();
        if (before.length > 2) u.label = before.slice(0, 140);
      } else if (u.label.length <= 6 || /^(month|day|year|date|city|state|from|to)$/i.test(u.label)) {
        const q0 = beforeText(el).split('|').pop().trim();
        if (q0.length > 6 && !q0.includes(u.label)) u.label = q0.slice(0, 120) + ' — ' + u.label;
      }
    });
    units = units.filter((u) => u.label && u.label.length > 2);
    units.forEach((u, i) => { u.id = i; }); // re-key: registry index must equal plan id
    if (!units.length) return { plan: [] };

    // Answers: one batched profile-mapping call, then AI per field where needed.
    const r = await msg('ASSIST_AUTOFILL', { fields: units.map((u) => u.label) });
    const answers = (r && r.answers) || {};
    let chooseBudget = 24, answerBudget = 12, openBudget = 10;
    for (const u of units) {
      u.value = String(answers[u.label] || '').trim();
      u.source = u.value ? 'profile' : '';
      // Custom widgets: briefly open them to read their REAL options so the AI can
      // choose among what the form actually offers (Workday/react-select/MUI).
      if (u.kind === 'custom' && smart && smart.readDropdownOptions && openBudget-- > 0) {
        try {
          const opts = await smart.readDropdownOptions(u.el);
          if (opts.length >= 2) u.options = opts;
        } catch (_) { /* fill by typed value instead */ }
      }
      const multiKind = u.kind === 'checkbox' || u.kind === 'aria-checkbox';
      const choice = ['select', 'radio', 'aria-radio', 'checkbox', 'aria-checkbox'].includes(u.kind)
        || (u.kind === 'custom' && u.options);
      if (choice) {
        const match = u.value && u.options.some((o) => norm(o) === norm(u.value) || norm(o).includes(norm(u.value)));
        if (!match && chooseBudget-- > 0) {
          try {
            const c = await msg('ASSIST_CHOOSE', { question: u.label, options: u.options, multi: multiKind });
            const sel = (c && c.selected) || [];
            if (sel.length) { u.value = sel.join(', '); u.source = 'ai'; }
            else if (!match) { u.value = ''; u.source = ''; }
          } catch (_) { /* leave empty */ }
        }
      } else if (!u.value && u.kind === 'question' && answerBudget-- > 0) {
        try {
          const a = await msg('ASSIST_ANSWER', { question: u.label });
          if (a && a.answer) { u.value = a.answer; u.source = 'ai'; }
        } catch (_) { /* leave empty */ }
      }
    }

    planRegistry = units.map((u) => ({ kind: u.kind, el: u.el, els: u.els }));
    return {
      plan: units.map((u) => ({
        id: u.id, label: u.label, kind: u.kind, options: u.options ? u.options.slice(0, 25) : undefined,
        value: u.value || '', source: u.source || '',
      })),
    };
  }

  /**
   * Resolve a value onto one of the control's REAL options.
   *  1. exact label,
   *  2. substring either way,
   *  3. shared significant word (so "8 and above" matches "8 and above CGPA"),
   *  4. last resort — hand the AI the exact on-page options and let it pick.
   * Step 4 is the key change: a choice whose value didn't literally match an option used to
   * be abandoned ("couldn't set field N"). Now the model chooses among what the form offers,
   * the same reasoning a human uses to see "9.1" belongs in "8 and above".
   */
  async function resolveOption(label, value, opts) {
    const texts = opts.map((o) => norm(o.text));
    const want = norm(value);
    let i = texts.findIndex((t) => t === want);
    if (i < 0) i = texts.findIndex((t) => t && (t.includes(want) || want.includes(t)));
    if (i < 0) {
      const vw = want.split(/\s+/).filter((w) => w.length > 2);
      i = texts.findIndex((t) => { const tw = t.split(/\s+/); return vw.some((w) => tw.includes(w)); });
    }
    if (i < 0 && value) {
      try {
        const c = await msg('ASSIST_CHOOSE', { question: label || 'Choose the best matching option', options: opts.map((o) => o.text), multi: false });
        const sel = ((c && c.selected) || [])[0];
        if (sel) i = texts.findIndex((t) => t === norm(sel));
      } catch (_) { /* give up below */ }
    }
    return i >= 0 ? opts[i] : null;
  }

  async function applyPlan(items) {
    const smart = window.JobPilotSmart;
    let applied = 0;
    const failed = [];
    for (const it of items || []) {
      const reg = planRegistry[it.id];
      const value = String(it.value || '').trim();
      if (!reg || !value) continue;
      let ok = false;
      try {
        if (reg.kind === 'select') {
          const opts = [...reg.el.options].map((o) => ({ text: o.text, val: o.value }));
          const opt = await resolveOption(it.label, value, opts);
          if (opt) { reg.el.value = opt.val; reg.el.dispatchEvent(new Event('change', { bubbles: true })); window.JobPilot.highlight(reg.el); ok = true; }
        } else if (reg.kind === 'radio') {
          const opts = reg.els.map((g) => ({ text: nativeLabel(g), el: g }));
          const opt = await resolveOption(it.label, value, opts);
          if (opt) { clickInput(opt.el); window.JobPilot.highlight(opt.el); ok = true; }
        } else if (reg.kind === 'aria-radio') {
          const opts = reg.els.map((o) => ({ text: labelOf(o), el: o }));
          const opt = await resolveOption(it.label, value, opts);
          if (opt) { clickOption(opt.el); window.JobPilot.highlight(opt.el); ok = true; }
        } else if (reg.kind === 'checkbox') {
          const wants = value.split(/[;,]/).map((s) => norm(s)).filter(Boolean);
          reg.els.forEach((g) => {
            const l = norm(nativeLabel(g));
            if (wants.some((w) => l === w || l.includes(w) || w.includes(l)) && !g.checked) {
              clickInput(g); window.JobPilot.highlight(g); ok = true;
            }
          });
        } else if (reg.kind === 'aria-checkbox') {
          const wants = value.split(/[;,]/).map((s) => norm(s)).filter(Boolean);
          reg.els.forEach((o) => {
            const l = norm(labelOf(o));
            if (wants.some((w) => l === w || l.includes(w) || w.includes(l)) && o.getAttribute('aria-checked') !== 'true') {
              clickOption(o); window.JobPilot.highlight(o); ok = true;
            }
          });
        } else if (reg.kind === 'custom' || reg.kind === 'combo') {
          if (smart && await (reg.kind === 'combo' ? smart.fillTypeahead(reg.el, value) : smart.fillCustomDropdown(reg.el, value))) {
            window.JobPilot.highlight(reg.el); ok = true;
          } else if (reg.kind === 'combo') { writeValue(reg.el, value); ok = true; }
        } else {
          writeValue(reg.el, value); ok = true;
        }
        if (smart) await smart.sleep(100);
      } catch (_) { /* record as failed */ }
      if (ok) applied++; else failed.push(it.label || `field ${it.id}`);
    }
    return { applied, failed };
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

  // Google Forms / Drive-picker uploads have no <input type=file> — just an "Add file"
  // button that opens a cross-origin Drive picker. Find that button (scoped to the kind).
  function findUploadButton(kind) {
    const re = kind === 'cover' ? /cover|letter|motivation/i : kind === 'resume' ? /resume|cv|curriculum|biodata/i : null;
    const btns = [...document.querySelectorAll('[role="button"], button, [aria-label]')]
      .filter((b) => b.offsetParent !== null && /add file|upload file|upload a file|choose file|attach/i.test((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')));
    if (!btns.length) return null;
    if (re) {
      const m = btns.find((b) => { const box = b.closest('[role="listitem"], li, fieldset, section, div'); return box && re.test(box.textContent || ''); });
      if (m) return m;
    }
    return btns[0];
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
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
    if (input) {
      attachFileToInput(input, blob, name);
      return { attached: true, role, company };
    }
    // No real file input — Drive picker (Google Forms) or no upload field at all.
    const btn = findUploadButton('cover');
    downloadBlob(blob, name);
    if (btn) {
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return { attached: false, pickerOpened: true, role, company,
        note: `Generated your cover letter and downloaded "${name}". This form uploads via Google Drive — I opened the picker; choose "Upload" and pick it.` };
    }
    return { attached: false, downloaded: true, role, company,
      note: `No upload field here — I generated and downloaded "${name}" so you can attach it.` };
  }

  // ---- bootstrap ----------------------------------------------------------

  // Structured JobPosting data (schema.org JSON-LD) — the most reliable source when present.
  function jsonLdJob() {
    const orgName = (o) => (o && (typeof o === 'string' ? o : o.name)) || '';
    const locOf = (jl) => {
      const a = Array.isArray(jl) ? jl[0] : jl;
      const addr = a && a.address;
      if (!addr) return '';
      if (typeof addr === 'string') return addr;
      return [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ');
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data; try { data = JSON.parse(s.textContent); } catch (_) { continue; }
      const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const n of nodes) {
        const t = n && n['@type'];
        if (n && (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting')))) {
          return {
            title: (n.title || '').toString().trim(),
            company: orgName(n.hiringOrganization).toString().trim(),
            location: locOf(n.jobLocation),
          };
        }
      }
    }
    return null;
  }

  const hostWord = () => location.hostname.replace(/^www\./, '').split('.')[0];

  // Scan the current page for a job listing: prefer JSON-LD, else heuristics, else ask the
  // AI to read the page text and extract clean { title, company, location }.
  async function scanListing() {
    const meta = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || '';
    const ld = jsonLdJob();
    let title = (ld?.title || document.querySelector('h1')?.textContent || meta('meta[property="og:title"]', 'content') || document.title || '')
      .replace(/\s+/g, ' ').trim();
    let company = (ld?.company || meta('meta[property="og:site_name"]', 'content') || '').replace(/\s+/g, ' ').trim();
    let loc = (ld?.location || '').replace(/\s+/g, ' ').trim();

    // On form platforms og:site_name is the PLATFORM ("Google Docs"), not the employer —
    // blank it so the AI extracts the real company from the form's text instead.
    if (/form/.test(sourceLabel()) && /google|microsoft|office|typeform/i.test(company)) company = '';

    // Weak extraction (no JSON-LD title/company, or company is just the domain word)? Use AI.
    const weak = !title || !company || norm(company) === norm(hostWord()) || /^(apply|jobs|careers|www)$/i.test(company);
    if (weak) {
      try {
        const r = await msg('SCAN_JOB', { text: extractJobText(), title: document.title, url: location.href });
        if (r && r.title) title = r.title;
        if (r && r.company) company = r.company;
        if (r && r.location && !loc) loc = r.location;
      } catch (_) { /* keep heuristics */ }
    }
    if (!company) company = hostWord();
    return { title: (title || '').slice(0, 200), company: company.slice(0, 120), location: loc.slice(0, 120),
      url: location.href, sourceSite: sourceLabel(), raw: null };
  }

  // Where this save came from — form platforms get an explicit "…form" label so the
  // Saved page shows "applied via form" vs. a job site.
  function sourceLabel() {
    const h = location.hostname;
    if (h === 'docs.google.com' && location.pathname.startsWith('/forms')) return 'google-form';
    if (h === 'forms.office.com' || h === 'forms.microsoft.com') return 'ms-form';
    if (h.endsWith('typeform.com')) return 'typeform';
    if (h.includes('myworkdayjobs') || h.includes('workday')) return 'workday';
    if (h.includes('greenhouse.io')) return 'greenhouse';
    if (h.includes('lever.co')) return 'lever';
    if (h.includes('ashbyhq.com')) return 'ashby';
    if (h.includes('smartrecruiters.com')) return 'smartrecruiters';
    if (h.includes('recruitee.com')) return 'recruitee';
    if (h.includes('workable.com')) return 'workable';
    return h.replace(/^www\./, '');
  }

  async function saveListing() {
    const payload = await scanListing();
    if (!payload.title) throw new Error('No job title found on this page');
    return new Promise((resolve, reject) => {
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

    if (!candidates.length) return { filled: 0, total: 0, report: [] };
    const labels = [...new Set(candidates.map((c) => c.label))];
    const r = await msg('ASSIST_AUTOFILL', { fields: labels });
    const answers = (r && r.answers) || {};

    // Per-field outcome report so the popup can explain every unfilled field.
    const report = [];
    let filled = 0;
    for (const { el, label, kind } of candidates) {
      const v = answers[label];
      const hasValue = v && String(v).trim();
      // Choice widgets can still be answered without a profile value: the AI picks the
      // best of the field's own options (scenario dropdowns like "Salary Currency").
      if (!hasValue && kind !== 'select' && kind !== 'custom') {
        report.push({ label, status: 'unfilled', reason: 'no-data' });
        continue;
      }
      let ok = false;
      try {
        if (kind === 'select') {
          let opt = null;
          if (hasValue) {
            const want = norm(v);
            opt = [...el.options].find((o) => norm(o.text) === want) || [...el.options].find((o) => norm(o.text).includes(want));
          }
          if (!opt) {
            // Profile value missing or doesn't match any option — let the AI choose
            // among the ACTUAL options, given the question.
            const optionTexts = [...el.options].map((o) => o.text.trim())
              .filter((t) => t && !/^(select|choose|—|-|please select)/i.test(t));
            if (optionTexts.length && optionTexts.length <= 60) {
              const c = await msg('ASSIST_CHOOSE', { question: label, options: optionTexts, multi: false });
              const pick = norm(((c && c.selected) || [])[0] || '');
              if (pick) {
                opt = [...el.options].find((o) => norm(o.text) === pick)
                  || [...el.options].find((o) => norm(o.text).includes(pick) || pick.includes(norm(o.text)));
              }
            }
          }
          if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); window.JobPilot.highlight(el); filled++; ok = true; }
        } else if (kind === 'custom') {
          let val = hasValue ? String(v) : '';
          if (!val && smart && smart.readDropdownOptions) {
            // No profile value: open the widget, read its real options, let the AI pick.
            const opts = await smart.readDropdownOptions(el);
            if (opts.length >= 2) {
              const c = await msg('ASSIST_CHOOSE', { question: label, options: opts, multi: false });
              val = (((c && c.selected) || [])[0] || '');
            }
          }
          if (val && await smart.fillCustomDropdown(el, val)) { window.JobPilot.highlight(el); filled++; ok = true; }
        } else if (kind === 'combo') {
          if ((el.value || '').trim()) { ok = true; }
          else if (await smart.fillTypeahead(el, String(v))) { window.JobPilot.highlight(el); filled++; ok = true; }
        } else {
          if ((el.value || '').trim()) { ok = true; }
          else { writeValue(el, String(v)); filled++; ok = true; }
        }
        if (smart) await smart.sleep(120);
      } catch (_) { /* keep going */ }
      report.push(ok
        ? { label, status: 'filled', value: String(v) }
        : { label, status: 'unfilled', reason: 'widget-failed', value: String(v) });
    }
    return { filled, total: candidates.length, report };
  }

  // Attach a stored resume to the page's file-upload field. docId picks a specific
  // LaTeX resume from the builder; without it the profile's uploaded resume is used.
  async function uploadResume(docId) {
    const r = await msg('GET_RESUME', { docId });
    if (!r || !r.hasResume) throw new Error('No resume on file — upload one in your JobPilot profile first');
    const bytes = Uint8Array.from(atob(r.contentBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: r.contentType || 'application/pdf' });
    const name = r.filename || 'resume.pdf';

    const input = findFileInput('resume');
    if (input) {
      attachFileToInput(input, blob, name);
      return { attached: true, filename: name };
    }
    // No real file input — Google Forms / Drive-picker style. Best we can do: download the
    // resume locally and open the picker so it's one click for the user.
    const btn = findUploadButton('resume');
    if (btn) {
      downloadBlob(blob, name);
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return { attached: false, pickerOpened: true, filename: name,
        note: `This form uploads via Google Drive, which extensions can't fill directly. I downloaded "${name}" and opened the picker — choose "Upload", then drag it in or pick it from Downloads.` };
    }
    throw new Error('No file-upload field found on this page');
  }

  // Popup-triggered actions (works on any page since this script loads everywhere).
  chrome.runtime.onMessage.addListener((m, _s, sendResponse) => {
    const ACTION_TYPES = ['AUTO_ANSWER', 'AI_FILL', 'PLAN_FILL', 'APPLY_FILL', 'UPLOAD_RESUME', 'ATTACH_COVER_LETTER', 'SAVE_CURRENT', 'FILL_FIELD'];
    if (ACTION_TYPES.includes(m.type) && window.JobPilot && !window.JobPilot.isEnabled()) {
      sendResponse({ ok: false, error: 'JobPilot is turned off — flip the toggle in the popup.' });
      return false;
    }
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
    // Review-first flow: scan + propose answers without touching the page…
    if (m.type === 'PLAN_FILL') {
      planFill().then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    // …then apply the (possibly user-edited) answers.
    if (m.type === 'APPLY_FILL') {
      applyPlan(m.items).then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (m.type === 'UPLOAD_RESUME') {
      uploadResume(m.docId).then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    // Side/popup "Tailor resume": hand back the page's JD text + role/company.
    if (m.type === 'EXTRACT_JD') {
      sendResponse({ ok: true, jdText: extractJobText(), role: pageRole(), company: pageCompany(), url: location.href.split('?')[0] });
      return true;
    }
    if (m.type === 'ATTACH_COVER_LETTER') {
      attachCoverLetter().then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    // Generic save — runs on ANY page. Only LinkedIn/Naukri/Indeed register their own
    // richer save handler (window.__jobpilotSaves); form fillers (Google/MS Forms,
    // Workday) claim __jobpilotHandled for FILL but still need this save path.
    if (m.type === 'SAVE_CURRENT' && !window.__jobpilotSaves) {
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhance);
  } else { enhance(); }

  window.JobPilotAssist = { enhance, autoAnswerAll, attachCoverLetter, deriveQuestion, isQuestionField };
})();
