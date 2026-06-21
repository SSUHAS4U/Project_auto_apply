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

$('fill').addEventListener('click', async () => {
  status('Filling…');
  const r = await tabSend('FILL');
  if (r.ok) status(`Filled ${r.filled} of ${r.total} fields — review & submit`, 'ok');
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
