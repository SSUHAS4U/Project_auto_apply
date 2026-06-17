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
  if (!resp || !resp.ok) {
    conn.textContent = 'not connected'; conn.className = 'sub err';
    $('profile').innerHTML = `<div class="muted">${resp ? resp.error : 'background unavailable'}</div>
      <div class="muted" style="margin-top:6px">Set backend &amp; token in Options.</div>`;
    return;
  }
  conn.textContent = 'connected'; conn.className = 'sub ok';
  const p = resp.data;
  $('profile').innerHTML = `
    <div class="pname">${p.full_name || '—'}</div>
    <div class="row">${p.email || ''}</div>
    <div class="row">${p.phone || ''} ${p.location ? '· ' + p.location : ''}</div>
    <div class="row">${(p.skills || []).slice(0, 6).join(', ')}</div>`;
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

$('refresh').addEventListener('click', () => { status('Refreshing…'); loadProfile(true).then(() => status('Profile refreshed', 'ok')); });
$('opts').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

loadProfile(false);
