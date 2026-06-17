// JobPilot field engine — generic label -> profile-value matcher.
// Exposes window.JobPilot with helpers used by every site filler.
(function () {
  if (window.JobPilot) return;

  // Synonym dictionary: profile key -> label keywords (normalized, lowercased).
  const SYNONYMS = {
    full_name: ['full name', 'your name', 'name', 'candidate name', 'applicant name'],
    first_name: ['first name', 'given name', 'forename'],
    last_name: ['last name', 'surname', 'family name'],
    email: ['email', 'e-mail', 'email address', 'mail'],
    phone: ['phone', 'mobile', 'contact number', 'phone number', 'telephone', 'cell'],
    location: ['location', 'city', 'current location', 'address', 'based in'],
    linkedin: ['linkedin', 'linkedin profile', 'linkedin url'],
    github: ['github', 'github profile', 'github url'],
    portfolio: ['portfolio', 'website', 'personal site', 'portfolio url'],
    seniority: ['seniority', 'experience level', 'level'],
  };

  function norm(s) {
    return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // Resolve a profile key to a concrete value.
  function valueFor(key, profile) {
    if (!profile) return null;
    const links = profile.links || {};
    const fieldMap = profile.field_map || {};
    const name = profile.full_name || '';
    switch (key) {
      case 'full_name': return name;
      case 'first_name': return name.split(' ')[0] || '';
      case 'last_name': return name.split(' ').slice(1).join(' ') || '';
      case 'email': return profile.email || '';
      case 'phone': return profile.phone || '';
      case 'location': return profile.location || '';
      case 'linkedin': return links.linkedin || '';
      case 'github': return links.github || '';
      case 'portfolio': return links.portfolio || '';
      case 'seniority': return profile.seniority || '';
      default: return fieldMap[key] || null;
    }
  }

  // Derive a human label for a form control from multiple signals.
  function deriveLabel(el) {
    // 1. <label for=id> or wrapping <label>
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl && lbl.textContent) return norm(lbl.textContent);
    }
    const wrap = el.closest('label');
    if (wrap && wrap.textContent) return norm(wrap.textContent);
    // 2. aria-label / aria-labelledby
    if (el.getAttribute('aria-label')) return norm(el.getAttribute('aria-label'));
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const ref = document.getElementById(labelledby);
      if (ref) return norm(ref.textContent);
    }
    // 3. placeholder / name / nearby text
    if (el.placeholder) return norm(el.placeholder);
    if (el.name) return norm(el.name);
    const prev = el.previousElementSibling;
    if (prev && prev.textContent && prev.textContent.length < 80) return norm(prev.textContent);
    return '';
  }

  // Match a label string to a profile key + value.
  function match(label, profile) {
    if (!label) return null;
    // Try field_map custom keys first (exact key contained in label).
    const fieldMap = (profile && profile.field_map) || {};
    for (const k of Object.keys(fieldMap)) {
      if (label.includes(norm(k))) return { key: k, value: fieldMap[k] };
    }
    for (const [key, words] of Object.entries(SYNONYMS)) {
      if (words.some((w) => label.includes(w))) {
        const value = valueFor(key, profile);
        if (value) return { key, value };
      }
    }
    return null;
  }

  // Set value in a way React/Angular/Vue notice (native setter + events).
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function highlight(el) {
    el.style.outline = '2px solid #6366f1';
    el.style.outlineOffset = '1px';
    el.style.transition = 'outline-color .3s';
    setTimeout(() => { el.style.outlineColor = 'rgba(99,102,241,0.35)'; }, 700);
  }

  // Fill all standard text-like inputs/textareas on the page.
  function fillTextInputs(profile) {
    const controls = document.querySelectorAll(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea'
    );
    let filled = 0, total = 0;
    controls.forEach((el) => {
      if (el.disabled || el.readOnly || el.offsetParent === null) return;
      total++;
      if (el.value && el.value.trim()) return; // don't overwrite
      const m = match(deriveLabel(el), profile);
      if (m && m.value) {
        setNativeValue(el, m.value);
        highlight(el);
        filled++;
      }
    });
    return { filled, total };
  }

  // Floating badge with the fill summary. Never submits anything.
  function showBadge(text) {
    let b = document.getElementById('jobpilot-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'jobpilot-badge';
      b.style.cssText = [
        'position:fixed', 'bottom:18px', 'right:18px', 'z-index:2147483647',
        'background:#161a23', 'color:#e7e9ee', 'border:1px solid #6366f1',
        'border-radius:10px', 'padding:10px 14px', 'font:600 13px system-ui,sans-serif',
        'box-shadow:0 8px 30px rgba(0,0,0,.4)',
      ].join(';');
      document.body.appendChild(b);
    }
    b.textContent = text;
    setTimeout(() => { if (b) b.style.opacity = '0.85'; }, 50);
  }

  function getProfile(force) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'GET_PROFILE', force }, (resp) => {
        if (!resp) return reject(new Error('extension background not reachable'));
        resp.ok ? resolve(resp.data) : reject(new Error(resp.error));
      });
    });
  }

  function saveJob(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'SAVE_JOB', payload }, (resp) => {
        if (!resp) return reject(new Error('extension background not reachable'));
        resp.ok ? resolve(resp.data) : reject(new Error(resp.error));
      });
    });
  }

  // Inject a floating "Save to JobPilot" button. extractor() -> listing payload.
  function injectSaveButton(site, extractor) {
    if (document.getElementById('jobpilot-save')) return;
    const btn = document.createElement('button');
    btn.id = 'jobpilot-save';
    btn.textContent = '🔖 Save to JobPilot';
    btn.style.cssText = [
      'position:fixed', 'bottom:18px', 'left:18px', 'z-index:2147483647',
      'background:linear-gradient(135deg,#6366f1,#4f46e5)', 'color:#fff', 'border:none',
      'border-radius:10px', 'padding:10px 16px', 'font:700 13px system-ui,sans-serif',
      'cursor:pointer', 'box-shadow:0 8px 24px rgba(79,70,229,.5)',
    ].join(';');
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const payload = extractor();
        payload.sourceSite = site;
        await saveJob(payload);
        btn.textContent = '✓ Saved';
        setTimeout(() => { btn.textContent = '🔖 Save to JobPilot'; btn.disabled = false; }, 2000);
      } catch (e) {
        btn.textContent = '⚠ ' + e.message;
        setTimeout(() => { btn.textContent = '🔖 Save to JobPilot'; btn.disabled = false; }, 3000);
      }
    });
    document.body.appendChild(btn);
  }

  function textOf(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent && el.textContent.trim()) return el.textContent.trim();
    }
    return '';
  }

  window.JobPilot = {
    norm, deriveLabel, match, valueFor, setNativeValue, highlight,
    fillTextInputs, showBadge, getProfile, saveJob, injectSaveButton, textOf, SYNONYMS,
  };
})();
