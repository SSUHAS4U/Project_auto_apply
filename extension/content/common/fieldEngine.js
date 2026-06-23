// JobPilot field engine — generic label -> profile-value matcher.
// Exposes window.JobPilot with helpers used by every site filler.
(function () {
  if (window.JobPilot) return;

  // Synonym dictionary: profile key -> label keywords (normalized, lowercased).
  // Order matters — more specific keys are matched before generic ones.
  const SYNONYMS = {
    first_name: ['first name', 'given name', 'forename'],
    last_name: ['last name', 'surname', 'family name'],
    full_name: ['full name', 'your name', 'candidate name', 'applicant name', 'name'],
    email: ['email', 'e-mail', 'email address'],
    phone: ['phone', 'mobile', 'contact number', 'phone number', 'telephone', 'cell', 'whatsapp'],
    linkedin: ['linkedin'],
    github: ['github'],
    leetcode: ['leetcode', 'dsa profile', 'dsa coding', 'coding profile', 'competitive programming', 'codeforces', 'hackerrank', 'codechef', 'geeksforgeeks', 'gfg'],
    portfolio: ['portfolio', 'personal website', 'personal site', 'website url', 'website'],
    current_title: ['current title', 'current role', 'current designation', 'job title', 'present role'],
    current_company: ['current company', 'company name', 'current employer', 'present company', 'organization', 'employer', 'company'],
    years_experience: ['years of experience', 'total experience', 'work experience', 'experience in years', 'years exp'],
    current_ctc: ['current ctc', 'present ctc', 'current salary', 'present salary', 'current compensation', 'current package', 'present package'],
    expected_ctc: ['expected ctc', 'expected salary', 'salary expectation', 'expected compensation', 'desired salary', 'expected package'],
    college: ['college', 'university', 'institution', 'institute', 'school name', 'college/university', 'university name', 'college name', 'alma mater'],
    notice_period: ['notice period', 'notice', 'availability to join'],
    available_from: ['available from', 'start date', 'available to start', 'earliest start', 'joining date'],
    work_authorization: ['work authorization', 'work permit', 'authorized to work', 'visa status', 'work status'],
    requires_sponsorship: ['sponsorship', 'require sponsorship', 'need sponsorship', 'visa sponsorship'],
    willing_to_relocate: ['relocate', 'willing to relocate', 'open to relocation'],
    city: ['city'],
    state: ['state', 'province'],
    country: ['country'],
    postal_code: ['postal code', 'zip code', 'zip', 'pincode', 'pin code'],
    address: ['address', 'street address', 'mailing address'],
    location: ['location', 'current location', 'based in'],
    nationality: ['nationality'],
    gender: ['gender', 'sex'],
    date_of_birth: ['date of birth', 'dob', 'birth date'],
    seniority: ['seniority', 'experience level', 'level'],
    summary: ['summary', 'about you', 'about yourself', 'cover letter', 'why should we hire', 'tell us about'],
    headline: ['headline', 'professional headline', 'tagline'],
  };

  function norm(s) {
    return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function boolToText(v) {
    if (v === true) return 'Yes';
    if (v === false) return 'No';
    return '';
  }

  // Resolve a profile key to a concrete value.
  function valueFor(key, profile) {
    if (!profile) return null;
    const links = profile.links || {};
    const fieldMap = profile.field_map || {};
    const name = profile.full_name || '';
    switch (key) {
      case 'full_name': return name;
      case 'first_name': return profile.first_name || name.split(' ')[0] || '';
      case 'last_name': return profile.last_name || name.split(' ').slice(1).join(' ') || '';
      case 'email': return profile.email || '';
      case 'phone': return profile.phone || '';
      case 'headline': return profile.headline || '';
      case 'summary': return profile.summary || '';
      case 'location': return profile.location || '';
      case 'address': return profile.address || '';
      case 'city': return profile.city || '';
      case 'state': return profile.state || '';
      case 'country': return profile.country || '';
      case 'postal_code': return profile.postal_code || '';
      case 'nationality': return profile.nationality || '';
      case 'gender': return profile.gender || '';
      case 'date_of_birth': return profile.date_of_birth || '';
      case 'linkedin': return links.linkedin || '';
      case 'github': return links.github || '';
      case 'leetcode': return links.leetcode || links.coding || links.codeforces || '';
      case 'portfolio': return links.portfolio || '';
      case 'college': return profile.college || '';
      case 'seniority': return profile.seniority || '';
      case 'current_title': return profile.current_title || '';
      case 'current_company': return profile.current_company || '';
      case 'years_experience': return profile.years_experience || '';
      case 'current_ctc': return profile.current_ctc || '';
      case 'expected_ctc': return profile.expected_ctc || '';
      case 'notice_period': return profile.notice_period || '';
      case 'available_from': return profile.available_from || '';
      case 'work_authorization': return profile.work_authorization || '';
      case 'requires_sponsorship': return boolToText(profile.requires_sponsorship);
      case 'willing_to_relocate': return boolToText(profile.willing_to_relocate);
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
    // 3. a label/legend inside the field's OWN small container — covers the very common
    //    <div><label>Current Company</label><input></div> pattern (label as a sibling).
    const box = el.closest('div, li, fieldset, .field, .form-group, p, section');
    if (box && box.querySelectorAll('input, select, textarea').length <= 2) {
      const lbl = box.querySelector('label, legend, [class*="label"], [class*="Label"]');
      if (lbl) { const t = norm(lbl.textContent); if (t.length > 1 && t.length < 90) return t; }
    }
    // 4. previous-sibling text (a bare label/span before the input)
    const prev = el.previousElementSibling;
    if (prev && prev.textContent && prev.textContent.length < 80) {
      const t = norm(prev.textContent); if (t.length > 1) return t;
    }
    // 5. placeholder / name (least reliable — used only as a last resort)
    if (el.placeholder) return norm(el.placeholder);
    if (el.name) return norm(el.name);
    return '';
  }

  // Match a label to the BEST profile key — the longest/most-specific synonym wins, so
  // "College/University Name" maps to college (via "university name") instead of full_name
  // (via the greedy "name"), and "Current Company" maps to current_company.
  function match(label, profile) {
    if (!label) return null;
    let best = null, bestLen = 0;
    // Custom field_map answers take priority, but still by longest match.
    const fieldMap = (profile && profile.field_map) || {};
    for (const k of Object.keys(fieldMap)) {
      const nk = norm(k);
      if (nk && fieldMap[k] && label.includes(nk) && nk.length > bestLen) { best = { key: k, value: fieldMap[k] }; bestLen = nk.length; }
    }
    for (const [key, words] of Object.entries(SYNONYMS)) {
      for (const w of words) {
        if (w.length > bestLen && label.includes(w)) {
          const value = valueFor(key, profile);
          if (value) { best = { key, value }; bestLen = w.length; }
        }
      }
    }
    return best;
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
