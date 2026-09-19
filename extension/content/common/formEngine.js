// JobPilot form engine — collect, label, resolve and write ANY web form.
//
// This replaces the keyword-dictionary filler. The old design matched a derived label against a
// fixed ~40-entry synonym list and wrote only to text inputs; a label phrased outside the list
// was left empty with no fallback, and selects/radios/checkboxes/comboboxes — most of a Workday
// form — were never touched at all. See docs/ARCHITECTURE.md §3.
//
// The design here has no per-site branching. It works the same way everywhere:
//
//   collect()  every control, across shadow roots and same-origin iframes, grouped into
//              LOGICAL fields (a radio group is one field, not six)
//   label()    scoped to the smallest DOM region that contains exactly this one control, so a
//              heading belonging to a section can never be handed to every field beneath it
//   resolve()  pass 1 profile dictionary (instant, local), pass 2 one batched backend call for
//              everything left — the backend already answers from the saved Q&A bank, then the
//              profile, and only then the model
//   write()    a typed writer per control kind, not one value-setter for everything
//
// Exposes window.JobPilotForm.
(function () {
  if (window.JobPilotForm) return;

  const smart = window.JobPilotSmart;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const norm = (s) => clean(s).toLowerCase();

  // ---------------------------------------------------------------- visibility

  // `offsetParent === null` was the old test. It is also null for every `position: fixed`
  // element, which silently skipped visible fields on any form with a sticky panel.
  //
  // Controls that are deliberately invisible but still the real input are the exception:
  // custom checkboxes, radios and file pickers are routinely a zero-opacity input layered
  // under a styled span, and refusing those would skip the control we actually have to click.
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const type = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
    const proxied = ['checkbox', 'radio', 'file'].includes(type);
    const r = el.getBoundingClientRect();
    if (!proxied && r.width === 0 && r.height === 0) return false;
    let cs;
    try { cs = getComputedStyle(el); } catch (_) { return false; }
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (!proxied && cs.opacity === '0') return false;
    // An ancestor may hide the whole block (a collapsed accordion, an inactive wizard step).
    for (let p = el.parentElement, d = 0; p && d < 24; p = p.parentElement, d++) {
      let pcs;
      try { pcs = getComputedStyle(p); } catch (_) { break; }
      if (pcs.display === 'none' || pcs.visibility === 'hidden') return false;
      if (p.hasAttribute && p.hasAttribute('hidden')) return false;
      if (p.getAttribute && p.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- deep roots

  // Every document-like root we are allowed to read: this document, every open shadow root,
  // and every SAME-ORIGIN iframe (Greenhouse and Lever render their form inside one, which the
  // old engine never looked into). Cross-origin frames throw on access and are skipped — their
  // own injected copy of this script handles them, because the manifest matches all frames.
  function deepRoots(root = document, out = [], seen = new Set()) {
    if (!root || seen.has(root)) return out;
    seen.add(root);
    out.push(root);
    let all = [];
    try { all = [...root.querySelectorAll('*')]; } catch (_) { return out; }
    for (const el of all) {
      if (el.shadowRoot) deepRoots(el.shadowRoot, out, seen);
      if (el.tagName === 'IFRAME') {
        try {
          const doc = el.contentDocument;
          if (doc && doc.documentElement) deepRoots(doc, out, seen);
        } catch (_) { /* cross-origin — its own content script covers it */ }
      }
    }
    return out;
  }

  function queryAll(selector) {
    const out = [];
    for (const root of deepRoots()) {
      try { out.push(...root.querySelectorAll(selector)); } catch (_) { /* ignore */ }
    }
    return out;
  }

  // ---------------------------------------------------------------- classify

  // Containers ([role=radiogroup], [role=group], fieldset) are deliberately absent: they are
  // how controls are GROUPED, not controls themselves. Listing one here made it collect as a
  // field in its own right and classify as 'text'.
  const CONTROL_SEL = 'input, textarea, select, [contenteditable="true"], '
    + '[role="combobox"], [role="listbox"], [role="checkbox"], [role="radio"]';

  const SKIP_TYPES = ['hidden', 'submit', 'button', 'reset', 'image', 'password'];

  function kindOf(el) {
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'SELECT') return el.multiple ? 'multiselect' : 'select';
    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') return 'contenteditable';
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'file') return 'file';
      if (['date', 'month', 'week', 'datetime-local'].includes(t)) return 'date';
      if (['email', 'tel', 'url', 'number'].includes(t)) return t;
      // A text input that drives a popup list is a combobox, not a text box: writing a raw
      // value into one leaves the widget's own state unset and the form rejects it on submit.
      if (smart && smart.isCustomDropdown(el)) return 'combobox';
      if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete')
          || el.getAttribute('aria-haspopup') === 'listbox') return 'combobox';
      return 'text';
    }
    const role = el.getAttribute && el.getAttribute('role');
    if (role === 'combobox' || role === 'listbox') return 'combobox';
    if (role === 'checkbox') return 'checkbox';
    if (role === 'radio') return 'radio';
    return 'text';
  }

  // ---------------------------------------------------------------- scoping

  // The count of LOGICAL controls inside a node. Radios and checkboxes that share a name are
  // one control, so a fieldset of six radio buttons still scopes as a single question.
  function controlCount(node) {
    let els;
    try { els = [...node.querySelectorAll(CONTROL_SEL)]; } catch (_) { return 0; }
    const keys = new Set();
    for (const el of els) {
      if (el.tagName === 'INPUT' && SKIP_TYPES.includes((el.getAttribute('type') || '').toLowerCase())) continue;
      if (!isVisible(el)) continue;
      const k = kindOf(el);
      if (k === 'radio' || k === 'checkbox') keys.add(k + ':' + (el.name || groupKeyFor(el)));
      else keys.add('el:' + (el.dataset.jpUid || (el.dataset.jpUid = String(++uid))));
    }
    return keys.size;
  }

  let uid = 0;

  function groupKeyFor(el) {
    const fs = el.closest && el.closest('fieldset, [role="radiogroup"], [role="group"]');
    if (fs) {
      if (!fs.dataset.jpGid) fs.dataset.jpGid = 'g' + (++uid);
      return fs.dataset.jpGid;
    }
    return el.name || ('anon' + (++uid));
  }

  /**
   * The largest ancestor that still contains EXACTLY this one logical control.
   *
   * This is the fix for the wrong-question bug. The old code did `el.closest('div')` and read
   * the first heading inside it — when that div wrapped several fields, every one of them was
   * handed the same label, which is why the AI answer "worked sometimes". Here the walk stops
   * the moment the ancestor picks up a second control, so a section heading can never be
   * attributed to the fields under it.
   */
  function labelScope(el) {
    let best = el;
    let node = el.parentElement;
    for (let d = 0; node && node.tagName !== 'BODY' && node.tagName !== 'HTML'
                    && node.tagName !== 'FORM' && d < 12; d++) {
      if (controlCount(node) > 1) break;
      best = node;
      node = node.parentElement;
    }
    return best;
  }

  // ---------------------------------------------------------------- labelling

  const GENERIC_LABEL = /^(your answer|answer|response|short answer|long answer|paragraph text|text|enter your answer|type here|untitled question|required question|select|choose|choose one|please select|--|none)\b/i;
  const JUNK_NAME = /^(field|input|q|question|item|el|ctrl|control|answer)[_\-]?\d|^\d+$|^[a-z]?\d[\d_\-]*$|^[a-z0-9]{16,}$/i;

  function usable(t) {
    const c = clean(t);
    return c.length > 1 && c.length < 300 && !GENERIC_LABEL.test(c);
  }

  function humanize(s) {
    return clean(String(s || '')
      .replace(/[_\-.]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2'));
  }

  function stripMarks(s) {
    return clean(s).replace(/\s*\*\s*$/, '').replace(/\s*\(required\)\s*$/i, '')
      .replace(/\s*required question\s*$/i, '').replace(/\s*:\s*$/, '').trim();
  }

  // Text belonging to the control itself or to its options — never the question.
  function ownText(el, scope) {
    const own = new Set();
    const add = (v) => { if (v) own.add(norm(v)); };
    add(el.value); add(el.placeholder);
    add(el.getAttribute && el.getAttribute('aria-label'));
    if (el.tagName === 'SELECT') for (const o of el.options) add(o.text);
    try {
      for (const o of scope.querySelectorAll('option, [role="option"], [role="radio"], [role="checkbox"]')) add(o.textContent);
    } catch (_) { /* ignore */ }
    return own;
  }

  function tableLabel(el) {
    const cell = el.closest && el.closest('td, th');
    const table = el.closest && el.closest('table');
    if (!cell || !table) return '';
    const row = cell.parentElement;
    const idx = row ? [...row.children].indexOf(cell) : -1;
    const head = table.querySelector('thead tr') || table.querySelector('tr');
    const col = head && idx >= 0 ? head.children[idx] : null;
    const rowHead = row ? row.querySelector('th') : null;
    return clean([rowHead && rowHead.textContent, col && col.textContent].filter(Boolean).join(' — '));
  }

  /**
   * Derive the question for one control, and say how much to trust it.
   * Returns {text, confidence, source}. Confidence matters: a weak label is still sent to the
   * backend, but with `context` attached so the model can recover from it rather than answering
   * the wrong question confidently.
   */
  function deriveLabel(el, scope) {
    const doc = el.ownerDocument || document;

    // 1. Explicit association. `label[for]` and aria-labelledby are the only signals a page
    //    states outright, so they outrank everything inferred from position.
    if (el.id) {
      let lbl = null;
      try { lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`); } catch (_) { /* bad id */ }
      if (lbl && usable(lbl.textContent)) return { text: stripMarks(lbl.textContent), confidence: 1, source: 'label-for' };
    }
    const lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      const parts = lb.split(/\s+/).map((id) => { try { return doc.getElementById(id); } catch (_) { return null; } })
        .filter(Boolean).map((n) => n.textContent);
      const t = clean(parts.join(' '));
      if (usable(t)) return { text: stripMarks(t), confidence: 1, source: 'labelledby' };
    }
    const wrap = el.closest && el.closest('label');
    if (wrap && usable(wrap.textContent)) return { text: stripMarks(wrap.textContent), confidence: 0.95, source: 'label-wrap' };

    const al = el.getAttribute && el.getAttribute('aria-label');
    if (usable(al)) return { text: stripMarks(al), confidence: 0.9, source: 'aria-label' };

    // 2. A table grid states the question in the header cells, not beside the input.
    const tl = tableLabel(el);
    if (usable(tl)) return { text: stripMarks(tl), confidence: 0.8, source: 'table' };

    // 3. Inside the single-control scope only. Because the scope provably holds just this one
    //    control, anything label-shaped in it belongs to this control and nothing else.
    if (scope) {
      const own = ownText(el, scope);
      const SEL = 'legend, [role="heading"], h1, h2, h3, h4, h5, h6, label, '
        + '[class*="label" i], [class*="title" i], [class*="question" i], [class*="prompt" i]';
      let cands = [];
      try { cands = [...scope.querySelectorAll(SEL)]; } catch (_) { /* ignore */ }
      for (const c of cands) {
        if (c.contains(el)) continue;                    // a wrapper, not a label
        const t = stripMarks(c.textContent);
        if (usable(t) && !own.has(norm(t))) return { text: t, confidence: 0.85, source: 'scope-label' };
      }
      // 4. No label element: the first leaf text in the scope that isn't the control's own
      //    text or an option. Covers Microsoft Forms, which marks up no label at all.
      let leaves = [];
      try { leaves = [...scope.querySelectorAll('*')]; } catch (_) { /* ignore */ }
      for (const n of leaves) {
        if (n.contains(el)) continue;
        if (n.children.length) continue;                 // leaves only
        if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SCRIPT', 'STYLE'].includes(n.tagName)) continue;
        const t = stripMarks(n.textContent);
        if (usable(t) && !own.has(norm(t))) return { text: t, confidence: 0.7, source: 'scope-text' };
      }
    }

    // 5. Weak signals. Real, but routinely wrong, so they are marked as such.
    if (usable(el.placeholder)) return { text: stripMarks(el.placeholder), confidence: 0.5, source: 'placeholder' };
    for (const a of ['data-automation-id', 'name', 'id']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && !JUNK_NAME.test(v)) {
        const h = humanize(v);
        if (usable(h)) return { text: h, confidence: 0.35, source: a };
      }
    }
    return { text: '', confidence: 0, source: 'none' };
  }

  // Surroundings sent with a weak label so the backend can recover the real question rather
  // than answering a guess. The old /answer call sent none of this, which is why a mis-derived
  // question produced a confidently wrong answer instead of a recoverable one.
  function contextOf(el, scope) {
    const bits = [];
    const a = (n) => el.getAttribute && el.getAttribute(n);
    if (a('name')) bits.push('name=' + a('name'));
    if (a('data-automation-id')) bits.push('automation-id=' + a('data-automation-id'));
    if (a('placeholder')) bits.push('placeholder=' + a('placeholder'));
    if (scope) {
      const t = clean(scope.textContent);
      if (t) bits.push('around="' + t.slice(0, 240) + '"');
    }
    return bits.join('; ').slice(0, 420);
  }

  // ---------------------------------------------------------------- options

  function optionsFor(field) {
    const { kind, el, els } = field;
    if (kind === 'select' || kind === 'multiselect') {
      return [...el.options].map((o) => clean(o.text)).filter((t) => t && !GENERIC_LABEL.test(t));
    }
    if (kind === 'radio' || kind === 'checkbox') {
      return els.map((x) => clean(optionLabel(x))).filter(Boolean);
    }
    return [];
  }

  // The visible text of one radio/checkbox choice.
  function optionLabel(input) {
    const doc = input.ownerDocument || document;
    if (input.id) {
      try {
        const l = doc.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (l && clean(l.textContent)) return clean(l.textContent);
      } catch (_) { /* ignore */ }
    }
    const w = input.closest && input.closest('label');
    if (w && clean(w.textContent)) return clean(w.textContent);
    const al = input.getAttribute && input.getAttribute('aria-label');
    if (al) return clean(al);
    const p = input.parentElement;
    if (p && clean(p.textContent)) return clean(p.textContent).slice(0, 80);
    return clean(input.value || '');
  }

  // ---------------------------------------------------------------- collect

  /**
   * Every fillable field on the page as a LOGICAL unit.
   * A radio group is one field with options, not six unrelated controls.
   */
  function collect() {
    const raw = queryAll(CONTROL_SEL);
    const fields = [];
    const groups = new Map();
    let n = 0;

    for (const el of raw) {
      if (el.tagName === 'INPUT' && SKIP_TYPES.includes((el.getAttribute('type') || '').toLowerCase())) continue;
      if (el.disabled || el.readOnly) continue;
      if (el.closest && el.closest('[data-jobpilot-ui]')) continue;   // our own injected UI
      if (!isVisible(el)) continue;
      const kind = kindOf(el);
      if (kind === 'file') continue;                 // needs a real File; handled elsewhere

      if (kind === 'radio' || kind === 'checkbox') {
        const key = kind + ':' + (el.name || groupKeyFor(el));
        if (!groups.has(key)) {
          const scope = labelScope(el.closest('fieldset, [role="radiogroup"], [role="group"]') || el);
          const lab = deriveLabel(el.closest('fieldset, [role="radiogroup"], [role="group"]') || el, scope);
          groups.set(key, {
            id: 'jp' + (++n), kind, els: [], el, scope,
            label: lab.text, confidence: lab.confidence, labelSource: lab.source,
            context: contextOf(el, scope), required: false,
          });
        }
        const g = groups.get(key);
        g.els.push(el);
        if (el.required) g.required = true;
        continue;
      }

      const scope = labelScope(el);
      const lab = deriveLabel(el, scope);
      fields.push({
        id: 'jp' + (++n), kind, el, scope,
        label: lab.text, confidence: lab.confidence, labelSource: lab.source,
        context: contextOf(el, scope),
        required: !!(el.required || (el.getAttribute && el.getAttribute('aria-required') === 'true')),
      });
    }

    for (const g of groups.values()) fields.push(g);
    for (const f of fields) {
      f.options = optionsFor(f);
      f.value = currentValue(f);
    }
    return fields;
  }

  function currentValue(f) {
    if (f.kind === 'radio' || f.kind === 'checkbox') {
      return f.els.filter((x) => x.checked).map((x) => optionLabel(x)).join(', ');
    }
    if (f.kind === 'contenteditable') return clean(f.el.textContent);
    return clean(f.el.value || '');
  }

  // ---------------------------------------------------------------- writers

  function fireAll(el) {
    for (const t of ['input', 'change']) el.dispatchEvent(new Event(t, { bubbles: true }));
  }

  function matchOption(list, want) {
    const w = norm(want);
    if (!w) return -1;
    let i = list.findIndex((t) => norm(t) === w);
    if (i >= 0) return i;
    i = list.findIndex((t) => norm(t).startsWith(w) || w.startsWith(norm(t)));
    if (i >= 0) return i;
    i = list.findIndex((t) => norm(t).includes(w) || w.includes(norm(t)));
    return i;
  }

  // Dates: an <input type=date> only accepts yyyy-mm-dd, whatever the form displays.
  function toIsoDate(v) {
    const s = clean(v);
    let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      // Local components, NOT toISOString(): the string parses to local midnight, and
      // converting that to UTC rolls the date back a day for anyone west of Greenwich.
      const p2 = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    }
    return '';
  }

  async function write(f, value) {
    const v = typeof value === 'string' ? value : String(value == null ? '' : value);
    if (!v) return false;
    const el = f.el;
    try {
      switch (f.kind) {
        case 'select':
        case 'multiselect': {
          const texts = [...el.options].map((o) => clean(o.text));
          const i = matchOption(texts, v);
          if (i < 0) return false;
          el.selectedIndex = i;
          fireAll(el);
          return true;
        }
        case 'radio': {
          const texts = f.els.map((x) => optionLabel(x));
          const i = matchOption(texts, v);
          if (i < 0) return false;
          clickControl(f.els[i]);
          return true;
        }
        case 'checkbox': {
          // A checkbox question can take several answers; the backend returns them comma-joined.
          const texts = f.els.map((x) => optionLabel(x));
          let hit = false;
          for (const part of v.split(/\s*,\s*/).filter(Boolean)) {
            const i = matchOption(texts, part);
            if (i >= 0 && !f.els[i].checked) { clickControl(f.els[i]); hit = true; }
          }
          // A single yes/no checkbox has no matching option text — treat an affirmative as "tick".
          if (!hit && f.els.length === 1 && /^(yes|true|y|agree|accept|i agree|on)$/i.test(v.trim())) {
            if (!f.els[0].checked) { clickControl(f.els[0]); hit = true; }
          }
          return hit;
        }
        case 'combobox': {
          if (!smart) return false;
          if (el.tagName === 'INPUT') return await smart.fillTypeahead(el, v);
          return await smart.fillCustomDropdown(el, v);
        }
        case 'date': {
          const iso = toIsoDate(v);
          if (!iso) return false;
          smart ? smart.setValue(el, iso) : (el.value = iso, fireAll(el));
          return true;
        }
        case 'contenteditable': {
          el.focus();
          el.textContent = v;
          fireAll(el);
          return true;
        }
        default: {
          smart ? smart.setValue(el, v) : (el.value = v, fireAll(el));
          return true;
        }
      }
    } catch (_) {
      return false;
    }
  }

  // Click through the label when the input itself is the zero-opacity one under a styled span:
  // clicking the hidden input directly is ignored by some widgets.
  function clickControl(input) {
    const doc = input.ownerDocument || document;
    let proxy = null;
    if (input.id) {
      try { proxy = doc.querySelector(`label[for="${CSS.escape(input.id)}"]`); } catch (_) { /* ignore */ }
    }
    proxy = proxy || (input.closest && input.closest('label'));
    const target = (proxy && isVisible(proxy)) ? proxy : input;
    try { target.scrollIntoView({ block: 'nearest' }); } catch (_) { /* ignore */ }
    target.click();
    if (!input.checked) {
      // The click was swallowed (a custom widget that only listens to its own span).
      input.checked = true;
      fireAll(input);
    }
  }

  function highlight(el) {
    try {
      el.style.outline = '2px solid #6366f1';
      el.style.outlineOffset = '1px';
      setTimeout(() => { el.style.outlineColor = 'rgba(99,102,241,.35)'; }, 700);
    } catch (_) { /* ignore */ }
  }

  window.JobPilotForm = {
    collect, write, deriveLabel, labelScope, isVisible, kindOf, optionLabel,
    optionsFor, contextOf, matchOption, toIsoDate, deepRoots, queryAll, highlight,
    clickControl, currentValue, humanize, sleep,
  };
})();
