// JobPilot MV3 service worker — owns config, backend calls, profile cache.

// Clicking the toolbar icon opens the side panel (a tall right-side copilot) instead of a popup.
try {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch (_) { /* older Chrome */ }

// Defaults to the deployed backend so the extension works out-of-the-box.
// Override in Options only if you run the backend locally (http://localhost:8080).
const DEFAULTS = {
  backendUrl: 'https://35.212.189.37.sslip.io',
  dashboardUrl: 'https://project-auto-apply.vercel.app',
  jwt: '',
};

// Backends we've since retired — if a previously-installed copy still has one saved
// in storage (from a login before the move), silently repoint it to the live VM so the
// AI assist starts working again without the user touching Options. The JWT is kept
// (same Supabase DB + signing secret); if it's stale, the first call 401s and they re-login.
const RETIRED_BACKENDS = ['https://jobpilot-backend-owb0.onrender.com'];
async function migrateBackend() {
  try {
    const { backendUrl } = await chrome.storage.local.get('backendUrl');
    if (backendUrl && RETIRED_BACKENDS.includes(backendUrl.replace(/\/$/, ''))) {
      await chrome.storage.local.set({ backendUrl: DEFAULTS.backendUrl, profile: null, profileAt: 0 });
    }
  } catch (_) { /* storage unavailable */ }
}
migrateBackend();

async function getConfig() {
  const c = await chrome.storage.local.get(['backendUrl', 'dashboardUrl', 'jwt']);
  return {
    backendUrl: c.backendUrl || DEFAULTS.backendUrl,
    dashboardUrl: c.dashboardUrl || DEFAULTS.dashboardUrl,
    jwt: c.jwt || DEFAULTS.jwt,
  };
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
          // fieldType tells the backend what control it's answering into
          // (date/tel/url/email/number/textarea/dropdown) so the format matches.
          const data = await apiFetch('/api/assist/answer', {
            method: 'POST', body: JSON.stringify({ question: msg.question, fieldType: msg.fieldType }),
          });
          sendResponse({ ok: true, data });
          break;
        }
        case 'ASSIST_LABELS': {
          // AI names fields the DOM couldn't label, from their raw surroundings.
          const data = await apiFetch('/api/assist/labels', {
            method: 'POST', body: JSON.stringify({ fields: msg.fields }),
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
        case 'SCAN_JOB': {
          const data = await apiFetch('/api/assist/scan-job', {
            method: 'POST', body: JSON.stringify({ text: msg.text, title: msg.title, url: msg.url }),
          });
          sendResponse({ ok: true, data });
          break;
        }
        case 'GET_RESUME': {
          const q = msg.docId ? `?docId=${encodeURIComponent(msg.docId)}` : '';
          const data = await apiFetch(`/api/extension/resume${q}`);
          sendResponse({ ok: true, data });
          break;
        }
        case 'LIST_RESUMES': {
          const data = await apiFetch('/api/extension/resumes');
          sendResponse({ ok: true, data });
          break;
        }
        case 'TAILOR_RESUME': {
          // Create a JD-tailored copy of the base resume, then open its editor.
          const doc = await apiFetch('/api/resumes/tailor', {
            method: 'POST',
            body: JSON.stringify({ name: msg.name, jobUrl: msg.jobUrl, jdText: msg.jdText }),
          });
          const { dashboardUrl } = await getConfig();
          if (msg.openEditor !== false) {
            chrome.tabs.create({ url: `${dashboardUrl}/resumes?id=${doc.id}` });
          }
          sendResponse({ ok: true, data: doc });
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
        case 'AUTO_APPLY_QUEUE': {
          const data = await apiFetch('/api/extension/auto-apply/queue?limit=50');
          sendResponse({ ok: true, data });
          break;
        }
        case 'AUTO_APPLY_QUEUE_STATUS': {
          const data = await apiFetch(`/api/extension/auto-apply/queue/${msg.itemId}/status`, {
            method: 'POST', body: JSON.stringify({ status: msg.status }),
          });
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

// ---- update check -----------------------------------------------------------
// Unpacked extensions can't auto-update, but we can TELL you when you're behind:
// every ~6h (and on browser start) compare this manifest's version against the
// one the dashboard last deployed. Badge shows "NEW" + one notification per version.
async function checkForUpdate() {
  try {
    const { dashboardUrl } = await getConfig();
    const r = await fetch(`${dashboardUrl}/extension-version.json`, { cache: 'no-store' });
    if (!r.ok) return;
    const { version } = await r.json();
    const mine = chrome.runtime.getManifest().version;
    const newer = version && version !== mine
      && version.split('.').map(Number).some((n, i) => n > (Number(mine.split('.')[i]) || 0));
    if (!newer) { chrome.action.setBadgeText({ text: '' }); return; }
    chrome.action.setBadgeText({ text: 'NEW' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    const { notifiedVersion } = await chrome.storage.local.get('notifiedVersion');
    if (notifiedVersion !== version) {
      await chrome.storage.local.set({ notifiedVersion: version });
      notify('JobPilot update available',
        `v${version} is out (you have v${mine}). Repo folder: git pull + reload. Zip install: re-download from the dashboard's Saved page.`);
    }
  } catch (_) { /* offline — try again next alarm */ }
}
chrome.runtime.onInstalled.addListener(() => {
  migrateBackend();
  chrome.alarms.create('update-check', { periodInMinutes: 360 });
  checkForUpdate();
});
chrome.runtime.onStartup.addListener(() => { migrateBackend(); checkForUpdate(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'update-check') checkForUpdate(); });
