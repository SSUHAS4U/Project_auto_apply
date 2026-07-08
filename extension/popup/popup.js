const $ = (id) => document.getElementById(id);

function send(type, payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type, ...payload }, resolve));
}
function tabSend(type, payload) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) return resolve({ ok: false, error: 'no active tab' });
      chrome.tabs.sendMessage(tab.id, { type, ...payload }, (resp) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: 'No JobPilot on this page — reload it' });
        resolve(resp || { ok: false, error: 'no response' });
      });
    });
  });
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

$('fill').addEventListener('click', async () => {
  $('report').innerHTML = '';
  status('Filling…');
  const r = await tabSend('FILL');
  if (!r.ok) { status(r.error, 'err'); return; }
  let filled = r.filled || 0;
  status(`Filled ${filled} — adapting to the remaining fields with AI…`);
  const ai = await tabSend('AI_FILL');
  if (ai.ok) filled += ai.filled || 0;
  status(`Filled ${filled} — answering questions (radios, dropdowns, open text)…`);
  const ans = await tabSend('AUTO_ANSWER');
  const answered = ans.ok ? (ans.done || 0) : 0;
  renderReport(r.report, ai.ok ? ai.report : null);
  status(`Filled ${filled} field${filled === 1 ? '' : 's'}${answered ? ` + ${answered} question${answered === 1 ? '' : 's'}` : ''} — review & submit`, 'ok');
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
