const $ = (id) => document.getElementById(id);

function send(type, payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type, ...payload }, resolve));
}
// Message EVERY frame (embedded ATS forms live in iframes) and merge the results,
// instead of letting an empty top frame answer first and mask the real form frame.
function activeTab() {
  return new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, ([t]) => res(t || null)));
}
function frameList(tabId) {
  return new Promise((res) => {
    try {
      chrome.webNavigation.getAllFrames({ tabId }, (fs) => {
        if (chrome.runtime.lastError || !fs || !fs.length) return res([{ frameId: 0 }]);
        res(fs);
      });
    } catch (_) { res([{ frameId: 0 }]); }
  });
}
function sendToFrame(tabId, frameId, message) {
  return new Promise((res) => {
    try {
      chrome.tabs.sendMessage(tabId, message, { frameId }, (resp) => {
        if (chrome.runtime.lastError || !resp) return res(null);
        res({ ...resp, frameId });
      });
    } catch (_) { res(null); }
  });
}
async function tabSend(type, payload = {}) {
  const tab = await activeTab();
  if (!tab) return { ok: false, error: 'no active tab' };
  const frames = await frameList(tab.id);
  const results = (await Promise.all(
    frames.map((f) => sendToFrame(tab.id, f.frameId, { type, ...payload })),
  )).filter(Boolean);
  if (!results.length) return { ok: false, error: 'No JobPilot on this page — reload it' };
  const oks = results.filter((r) => r.ok);
  if (!oks.length) return results[0];
  switch (type) {
    case 'FILL':
    case 'AI_FILL': {
      const agg = { ok: true, filled: 0, total: 0, report: [] };
      oks.forEach((r) => { agg.filled += r.filled || 0; agg.total += r.total || 0; if (r.report) agg.report.push(...r.report); });
      return agg;
    }
    case 'AUTO_ANSWER': {
      const agg = { ok: true, done: 0, total: 0 };
      oks.forEach((r) => { agg.done += r.done || 0; agg.total += r.total || 0; });
      return agg;
    }
    case 'EXTRACT_JD':
      return oks.reduce((a, b) => (((b.jdText || '').length > (a.jdText || '').length) ? b : a));
    case 'UPLOAD_RESUME':
    case 'ATTACH_COVER_LETTER':
      return oks.find((r) => r.attached) || oks.find((r) => r.pickerOpened) || oks[0];
    default:
      return oks.find((r) => r.frameId === 0) || oks[0];
  }
}
function status(msg, kind = '') { const s = $('status'); s.textContent = msg; s.className = 'status ' + kind; }

// ---- global on/off toggle --------------------------------------------------

function applyEnabledUi(on) {
  $('power').checked = on;
  document.querySelectorAll('#actions .btn').forEach((b) => { b.disabled = !on; });
  if (!on) { status('JobPilot is off — pages are untouched.'); $('picker').hidden = true; }
  else if (/is off/.test($('status').textContent)) status('');
}

chrome.storage.local.get({ jobpilotEnabled: true }, (v) => applyEnabledUi(v.jobpilotEnabled !== false));

$('power').addEventListener('change', () => {
  const on = $('power').checked;
  chrome.storage.local.set({ jobpilotEnabled: on });
  applyEnabledUi(on);
});

// ---- profile ----------------------------------------------------------------

async function loadProfile(force) {
  const resp = await send('GET_PROFILE', { force });
  const conn = $('conn');
  if (!resp || !resp.ok) {
    conn.innerHTML = '<span class="dot"></span>not connected';
    conn.className = 'sub err';
    $('profile').innerHTML = `<div class="muted">${resp ? resp.error : 'background unavailable'}</div>
      <div class="muted" style="margin-top:4px">Sign in via <b>⚙ Options</b>.</div>`;
    return;
  }
  conn.innerHTML = '<span class="dot"></span>connected';
  conn.className = 'sub ok';
  const p = resp.data;
  $('profile').innerHTML = `<div class="pname">${p.full_name || 'Signed in'}</div>` +
    (p.headline ? `<div class="muted" style="font-size:11.5px;margin-top:2px">${p.headline}</div>` : '');
}

// ---- fill report: explain every field that could NOT be filled --------------

const REASON_TEXT = {
  'no-data': 'No info in your JobPilot profile — add it in Profile, or save an answer in the Q&A bank.',
  'no-match': 'Didn’t recognize this field — use the side-panel copilot or fill manually.',
  'no-label': 'Couldn’t read a label for this field.',
};

function reasonLine(item) {
  if (item.reason === 'no-value' && item.key) {
    return `Your profile’s “${item.key.replace(/_/g, ' ')}” is empty — add it and refill.`;
  }
  if (item.reason === 'widget-failed') {
    return item.value
      ? `Value ready (“${item.value}”) but this control resisted autofill — set it manually.`
      : 'This control type resisted autofill — set it manually.';
  }
  return REASON_TEXT[item.reason] || 'Could not be filled automatically.';
}

// FILL_NOW report: what went in, and what still needs the user.
function renderFillNow(r) {
  const box = $('report');
  box.innerHTML = '';
  const skipped = r.skipped || [];
  if (skipped.length) {
    const h = document.createElement('div');
    h.className = 'rephead';
    h.textContent = `⚠ ${skipped.length} field${skipped.length === 1 ? '' : 's'} left for you`;
    box.appendChild(h);
    skipped.slice(0, 8).forEach((label) => {
      const row = document.createElement('div');
      row.className = 'repitem';
      const l = document.createElement('div');
      l.className = 'replabel';
      l.textContent = label || '(unlabeled field)';
      const w = document.createElement('div');
      w.className = 'repwhy';
      w.textContent = 'No confident answer — fill this one in yourself.';
      row.append(l, w);
      box.appendChild(row);
    });
    if (skipped.length > 8) {
      const more = document.createElement('div');
      more.className = 'repwhy';
      more.textContent = `…and ${skipped.length - 8} more.`;
      box.appendChild(more);
    }
  }
  // Show what it DID write, so a wrong answer is caught in the popup and not after submitting.
  const details = (r.details || []).filter((d) => d.value);
  if (details.length) {
    const h2 = document.createElement('div');
    h2.className = 'rephead';
    h2.textContent = `Filled ${details.length}`;
    box.appendChild(h2);
    details.slice(0, 20).forEach((d) => {
      const row = document.createElement('div');
      row.className = 'repitem';
      const l = document.createElement('div');
      l.className = 'replabel';
      l.textContent = d.label;
      const w = document.createElement('div');
      w.className = 'repwhy';
      w.textContent = String(d.value).slice(0, 120) + (d.source ? `  · ${d.source}` : '');
      row.append(l, w);
      box.appendChild(row);
    });
  }
}

function renderReport(fillReport, aiReport) {
  const box = $('report');
  box.innerHTML = '';
  // The AI pass runs last over every still-empty field, so its "unfilled" list is
  // authoritative; add synonym-pass fields the AI pass never saw (unlabeled ones).
  const unfilled = (aiReport || []).filter((x) => x.status === 'unfilled');
  const seen = new Set(unfilled.map((x) => (x.label || '').toLowerCase()));
  (fillReport || []).forEach((x) => {
    if (x.status === 'unfilled' && x.reason === 'no-label' && !seen.has((x.label || '').toLowerCase())) {
      unfilled.push(x);
    }
  });
  if (!unfilled.length) return;

  const h = document.createElement('div');
  h.className = 'rephead';
  h.textContent = `⚠ ${unfilled.length} field${unfilled.length === 1 ? '' : 's'} need${unfilled.length === 1 ? 's' : ''} you`;
  box.appendChild(h);
  unfilled.slice(0, 8).forEach((item) => {
    const row = document.createElement('div');
    row.className = 'repitem';
    const label = document.createElement('div');
    label.className = 'replabel';
    label.textContent = item.label || '(unlabeled field)';
    const why = document.createElement('div');
    why.className = 'repwhy';
    why.textContent = reasonLine(item);
    row.append(label, why);
    box.appendChild(row);
  });
  if (unfilled.length > 8) {
    const more = document.createElement('div');
    more.className = 'repwhy';
    more.textContent = `…and ${unfilled.length - 8} more.`;
    box.appendChild(more);
  }
}

// ---- actions -----------------------------------------------------------------

// One click fills the whole form. This used to run three passes (FILL, then AI_FILL, then
// AUTO_ANSWER) over the same page, each with its own idea of what a field was — they
// re-answered each other's work and reported three different totals. FILL_NOW is one scan,
// one plan, one write, one report. It never submits.
$('fill').addEventListener('click', async () => {
  $('report').innerHTML = '';
  status('Reading the form…');
  const r = await tabSend('FILL_NOW');
  if (!r.ok) { status(r.error, 'err'); return; }
  renderFillNow(r);
  const n = r.filled || 0;
  if (!r.total) { status(r.note || 'No empty fields found here', 'ok'); return; }
  status(`Filled ${n} of ${r.total} — review the form, then submit it yourself`, 'ok');
});

$('answer').addEventListener('click', async () => {
  status('Generating answers…');
  const r = await tabSend('AUTO_ANSWER');
  if (r.ok) status(r.total ? `Answered ${r.done} of ${r.total} questions — review them` : 'No question fields found here', 'ok');
  else status(r.error, 'err');
});

$('cover').addEventListener('click', async () => {
  status('Writing cover letter…');
  const r = await tabSend('ATTACH_COVER_LETTER');
  if (r.ok) status(r.attached ? 'Cover letter attached ✓ — review & submit' : (r.note || 'Downloaded the PDF instead'), 'ok');
  else status(r.error, 'err');
});

$('save').addEventListener('click', async () => {
  status('Saving…');
  const r = await tabSend('SAVE_CURRENT');
  if (r.ok) status('Saved to tracker ✓', 'ok');
  else status(/No JobPilot/.test(r.error || '') ? r.error : 'Use the “Save to JobPilot” button on the page.', 'err');
});

// ---- resume picker: ask WHICH resume to upload, every time -------------------

$('resume').addEventListener('click', async () => {
  const picker = $('picker');
  if (!picker.hidden) { picker.hidden = true; return; }
  status('Loading your resumes…');
  const r = await send('LIST_RESUMES', {});
  if (!r || !r.ok) { status(r ? r.error : 'background unavailable', 'err'); return; }
  const list = $('pickerList');
  list.innerHTML = '';
  const options = r.data || [];
  if (!options.length) {
    status('No resumes yet — upload one in Profile, or build one in Dashboard → Resumes.', 'err');
    return;
  }
  options.forEach((o) => {
    const b = document.createElement('button');
    b.className = 'picker-item';
    b.disabled = !o.hasPdf;
    b.innerHTML = `<span>${o.base ? '⭐ ' : ''}${o.name}</span>` +
      (o.hasPdf ? '' : '<span class="pi-sub" style="margin-left:auto">not compiled</span>');
    b.addEventListener('click', async () => {
      picker.hidden = true;
      status(`Attaching “${o.name}”…`);
      const res = await tabSend('UPLOAD_RESUME', o.id ? { docId: o.id } : {});
      if (res.ok) status(res.note || `Attached ${res.filename} ✓`, 'ok');
      else status(res.error, 'err');
    });
    list.appendChild(b);
  });
  status('');
  picker.hidden = false;
});
$('pickerClose').addEventListener('click', () => { $('picker').hidden = true; });

// ---- tailor resume to this job's JD ------------------------------------------

$('tailor').addEventListener('click', async () => {
  status('Reading the job description…');
  const jd = await tabSend('EXTRACT_JD');
  if (!jd.ok) { status(jd.error, 'err'); return; }
  if (!jd.jdText || jd.jdText.length < 80) { status('Couldn’t find a job description on this page.', 'err'); return; }
  const name = [jd.role, jd.company].filter(Boolean).join(' – ').slice(0, 80) || 'Tailored resume';
  status('Tailoring a copy of your base resume…');
  const r = await send('TAILOR_RESUME', { name, jobUrl: jd.url, jdText: jd.jdText });
  if (r && r.ok) status('Tailored copy created ✓ — opening the editor to review & compile', 'ok');
  else status((r && r.error) || 'tailor failed', 'err');
});

$('refresh').addEventListener('click', () => { status('Refreshing…'); loadProfile(true).then(() => status('Profile refreshed', 'ok')); });
$('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());

loadProfile(false);
