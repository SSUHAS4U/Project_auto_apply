// JobPilot MV3 service worker — owns config, backend calls, profile cache.

// Clicking the toolbar icon opens the side panel (a tall right-side copilot) instead of a popup.
try {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch (_) { /* older Chrome */ }

// Defaults to the deployed backend so the extension works out-of-the-box.
// Override in Options only if you run the backend locally (http://localhost:8080).
const DEFAULTS = { backendUrl: 'https://jobpilot-backend-owb0.onrender.com', jwt: '' };

async function getConfig() {
  const c = await chrome.storage.local.get(['backendUrl', 'jwt']);
  return { backendUrl: c.backendUrl || DEFAULTS.backendUrl, jwt: c.jwt || DEFAULTS.jwt };
}

async function apiFetch(path, init = {}) {
  const { backendUrl, jwt } = await getConfig();
  if (!jwt) throw new Error('Not signed in. Open the extension Options and log in.');
  const res = await fetch(`${backendUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const b = await res.json(); if (b.message) msg = b.message; } catch (_) {}
    throw new Error(msg);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Login (no auth header needed) — stores the JWT for subsequent calls.
async function login(backendUrl, email, password) {
  const res = await fetch(`${backendUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    let msg = 'login failed';
    try { const b = await res.json(); if (b.message) msg = b.message; } catch (_) {}
    throw new Error(msg);
  }
  const data = await res.json();
  await chrome.storage.local.set({ backendUrl, jwt: data.token, profile: null, profileAt: 0 });
  return data.user;
}

// Profile cache (5 min TTL) so fillers don't hit the backend every page.
async function getProfile(force) {
  const cached = await chrome.storage.local.get(['profile', 'profileAt']);
  const fresh = cached.profileAt && Date.now() - cached.profileAt < 5 * 60 * 1000;
  if (!force && cached.profile && fresh) return cached.profile;
  const profile = await apiFetch('/api/extension/profile-export');
  await chrome.storage.local.set({ profile, profileAt: Date.now() });
  return profile;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'GET_CONFIG':
          sendResponse({ ok: true, data: await getConfig() });
          break;
        case 'LOGIN': {
          const user = await login(msg.backendUrl, msg.email, msg.password);
          sendResponse({ ok: true, data: user });
          break;
        }
        case 'LOGOUT':
          await chrome.storage.local.set({ jwt: '', profile: null, profileAt: 0 });
          sendResponse({ ok: true });
          break;
        case 'GET_PROFILE':
          sendResponse({ ok: true, data: await getProfile(msg.force) });
          break;
        case 'SAVE_JOB': {
          const data = await apiFetch('/api/extension/saved-job', {
            method: 'POST', body: JSON.stringify(msg.payload),
          });
          notify('Saved to JobPilot', `${msg.payload.title || 'Listing'} captured.`);
          sendResponse({ ok: true, data });
          break;
        }
        case 'CHECK_NOTIFICATIONS': {
          const data = await apiFetch('/api/notifications?unread=true');
          if (data && data.unreadCount > 0) {
            notify('JobPilot', `${data.unreadCount} unread notification(s).`);
          }
          sendResponse({ ok: true, data });
          break;
        }
        case 'ASSIST_ANSWER': {
          const data = await apiFetch('/api/assist/answer', {
            method: 'POST', body: JSON.stringify({ question: msg.question }),
          });
          sendResponse({ ok: true, data });
          break;
        }
        case 'ASSIST_CHOOSE': {
          const data = await apiFetch('/api/assist/choose', {
            method: 'POST',
            body: JSON.stringify({ question: msg.question, options: msg.options, multi: msg.multi }),
          });
          sendResponse({ ok: true, data });
          break;
        }
        case 'ASSIST_AUTOFILL': {
          const data = await apiFetch('/api/assist/autofill', {
            method: 'POST', body: JSON.stringify({ fields: msg.fields }),
          });
          sendResponse({ ok: true, data });
          break;
        }
        case 'ASSIST_COMMAND': {
          const data = await apiFetch('/api/assist/command', {
            method: 'POST', body: JSON.stringify({ instruction: msg.instruction, fields: msg.fields }),
          });
          sendResponse({ ok: true, data });
          break;
        }
        case 'GET_RESUME': {
          const data = await apiFetch('/api/extension/resume');
          sendResponse({ ok: true, data });
          break;
        }
        case 'SAVE_QA': {
          const data = await apiFetch('/api/assist/qa', {
            method: 'POST', body: JSON.stringify({ question: msg.question, answer: msg.answer }),
          });
          sendResponse({ ok: true, data });
          break;
        }
        case 'LIST_QA': {
          const data = await apiFetch('/api/assist/qa');
          sendResponse({ ok: true, data });
          break;
        }
        case 'GEN_COVER_LETTER': {
          const data = await apiFetch('/api/assist/cover-letter', {
            method: 'POST',
            body: JSON.stringify({ company: msg.company, role: msg.role, jobText: msg.jobText }),
          });
          sendResponse({ ok: true, data });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
    });
  } catch (_) { /* icon optional */ }
}
