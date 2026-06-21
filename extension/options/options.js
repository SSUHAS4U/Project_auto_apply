const $ = (id) => document.getElementById(id);

chrome.storage.local.get(['backendUrl', 'jwt'], (c) => {
  $('backendUrl').value = c.backendUrl || 'https://jobpilot-backend-owb0.onrender.com';
  if (c.jwt) $('who').textContent = '✓ Signed in';
});

function setStatus(msg, kind = '') { $('status').textContent = msg; $('status').className = 'status ' + kind; }

$('login').addEventListener('click', () => {
  const backendUrl = $('backendUrl').value.trim().replace(/\/$/, '');
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || !password) { setStatus('Enter email and password', 'err'); return; }
  setStatus('Signing in…');
  chrome.runtime.sendMessage({ type: 'LOGIN', backendUrl, email, password }, (resp) => {
    if (resp && resp.ok) {
      setStatus('Signed in ✓', 'ok');
      $('who').textContent = '✓ Signed in as ' + (resp.data.email || email);
      $('password').value = '';
    } else {
      setStatus('Failed: ' + (resp ? resp.error : 'no response'), 'err');
    }
  });
});

$('logout').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'LOGOUT' }, () => {
    setStatus('Signed out', 'ok'); $('who').textContent = '';
  });
});
