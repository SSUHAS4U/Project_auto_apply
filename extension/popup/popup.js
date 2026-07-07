const $ = (id) => document.getElementById(id);

function send(type, payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type, ...payload }, resolve));
}
function tabSend(type) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) return resolve({ ok: false, error: 'no active tab' });
      chrome.tabs.sendMessage(tab.id, { type }, (resp) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: 'No filler on this page' });
        resolve(resp || { ok: false, error: 'no response' });
      });
    });
  });
}
function status(msg, kind = '') { const s = $('status'); s.textContent = msg; s.className = 'status ' + kind; }

// ---- global on/off toggle --------------------------------------------------

function applyEnabledUi(on) {
  $('power').checked = on;
  document.querySelectorAll('#actions .btn').forEach((b) => {
    if (b.id !== 'refresh') b.disabled = !on;
  });
  if (!on) status('JobPilot is off — pages are untouched.', '');
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
  const opts = $('opts');
  if (!resp || !resp.ok) {
    conn.textContent = 'not connected'; conn.className = 'sub err';
    $('profile').innerHTML = `<div class="muted">${resp ? resp.error : 'background unavailable'}</div>
      <div class="muted" style="margin-top:6px">Sign in via Options.</div>`;
    if (opts) opts.textContent = '⚙ Options — sign in';
    return;
  }
  // Signed in: keep it minimal — just the name. Footer drops the "sign in" wording.
  conn.textContent = 'connected'; conn.className = 'sub ok';
  const p = resp.data;
  $('profile').innerHTML = `<div class="pname">${p.full_name || 'Signed in'}</div>`;
  if (opts) opts.textContent = '⚙ Options';
}

// ---- fill report: explain every field that could NOT be filled --------------

const REASON_TEXT = {
  'no-data': 'No info in your JobPilot profile — add it in Profile, or save an answer in the Q&A bank.',
  'no-value': null, // handled specially with the field key
  'no-match': 'Didn’t recognize this field — use the side-panel copilot or fill manually.',
  'no-label': 'Couldn’t read a label for this field.',
  'widget-failed': null, // handled specially with the value
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
  h.textContent = `⚠ ${unfilled.length} field${unfilled.length === 1 ? '' : 's'} need${unfilled.length === 1 ? 's' : ''} you:`;
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
  // Second pass: AI fills the factual fields the synonym engine missed (CTC, college, etc.)
  // and adapts to dropdowns/typeaheads. Returns a per-field report of what's left.
  status(`Filled ${filled} — adapting to the remaining fields with AI…`);
  const ai = await tabSend('AI_FILL');
  if (ai.ok) filled += ai.filled || 0;
  renderReport(r.report, ai.ok ? ai.report : null);
  status(`Filled ${filled} fields — review & submit`, 'ok');
});

$('resume').addEventListener('click', async () => {
  status('Attaching resume…');
  const r = await tabSend('UPLOAD_RESUME');
  if (r.ok) status(r.note || `Resume attached (${r.filename}) ✓`, 'ok');
  else status(r.error, 'err');
});

$('save').addEventListener('click', async () => {
  status('Saving…');
  let r = await tabSend('SAVE_CURRENT');
  if (!r.ok && /No filler/.test(r.error || '')) {
    status('Use the “Save to JobPilot” button on the page.', 'err');
    return;
  }
  if (r.ok) status('Saved to tracker ✓', 'ok'); else status(r.error, 'err');
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
  if (r.ok) status(r.attached ? 'Cover letter attached ✓ — review & submit' : 'No upload field — downloaded the PDF instead', 'ok');
  else status(r.error, 'err');
});

$('refresh').addEventListener('click', () => { status('Refreshing…'); loadProfile(true).then(() => status('Profile refreshed', 'ok')); });
$('opts').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

loadProfile(false);
