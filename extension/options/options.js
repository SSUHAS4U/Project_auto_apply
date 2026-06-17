const $ = (id) => document.getElementById(id);

chrome.storage.local.get(['backendUrl', 'token'], (c) => {
  $('backendUrl').value = c.backendUrl || 'http://localhost:8080';
  $('token').value = c.token || '';
});

function setStatus(msg, kind = '') { $('status').textContent = msg; $('status').className = 'status ' + kind; }

$('save').addEventListener('click', () => {
  const backendUrl = $('backendUrl').value.trim().replace(/\/$/, '');
  const token = $('token').value.trim();
  chrome.storage.local.set({ backendUrl, token, profile: null, profileAt: 0 }, () => setStatus('Saved ✓', 'ok'));
});

$('test').addEventListener('click', async () => {
  const backendUrl = $('backendUrl').value.trim().replace(/\/$/, '');
  const token = $('token').value.trim();
  setStatus('Testing…');
  try {
    const res = await fetch(`${backendUrl}/api/health`, { headers: { 'X-Api-Token': token } });
    if (res.ok) setStatus('Connected — token works ✓', 'ok');
    else setStatus(`Failed: ${res.status} ${res.statusText}`, 'err');
  } catch (e) {
    setStatus('Failed: ' + e.message, 'err');
  }
});
