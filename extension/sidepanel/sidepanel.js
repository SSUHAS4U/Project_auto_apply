const $ = (id) => document.getElementById(id);

function bg(type, payload) {
  return new Promise((r) => chrome.runtime.sendMessage({ type, ...payload }, r));
}
function tabSend(type, payload) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) return resolve({ ok: false, error: 'no active tab' });
      chrome.tabs.sendMessage(tab.id, { type, ...payload }, (resp) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: 'No JobPilot on this page (try reloading it)' });
        resolve(resp || { ok: false, error: 'no response' });
      });
    });
  });
}

function add(role, text, actions) {
  const chat = $('chat');
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.textContent = text;
  if (actions) {
    const a = document.createElement('div');
    a.className = 'msg-actions';
    actions.forEach(([label, fn]) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; a.appendChild(b); });
    d.appendChild(a);
  }
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}

async function loadProfile() {
  const r = await bg('GET_PROFILE', {});
  const ok = r && r.ok;
  $('conn').textContent = ok ? `connected · ${r.data.full_name || 'signed in'}` : (r ? r.error : 'sign in via Options');
  $('conn').className = 'sub ' + (ok ? 'ok' : 'err');
}

// --- action buttons -------------------------------------------------------
$('fill').onclick = async () => {
  add('me', 'Fill this form');
  const r = await tabSend('FILL');
  if (!r.ok) return void add('ai', '⚠ ' + r.error);
  let n = r.filled || 0;
  const ai = await tabSend('AI_FILL');
  if (ai.ok) n += ai.filled || 0;
  add('ai', `Filled ${n} fields — review & submit.`);
};
$('answer').onclick = async () => {
  add('me', 'AI-answer questions');
  const r = await tabSend('AUTO_ANSWER');
  add('ai', r.ok ? (r.total ? `Answered ${r.done} of ${r.total} questions — review them.` : 'No open-ended question fields found here.') : '⚠ ' + r.error);
};
$('resume').onclick = async () => {
  const r = await tabSend('UPLOAD_RESUME');
  if (!r.ok) return void add('ai', '⚠ ' + r.error);
  add('ai', r.attached ? `Resume attached (${r.filename}) ✓` : (r.note || 'Downloaded your resume.'));
};
$('cover').onclick = async () => {
  const r = await tabSend('ATTACH_COVER_LETTER');
  if (!r.ok) return void add('ai', '⚠ ' + r.error);
  add('ai', r.attached ? 'Cover letter attached ✓ — review & submit.' : (r.note || 'Downloaded the cover-letter PDF.'));
};
$('save').onclick = async () => { const r = await tabSend('SAVE_CURRENT'); add('ai', r.ok ? 'Saved to your tracker ✓' : '⚠ ' + r.error); };
$('opts').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

// --- copilot chat ---------------------------------------------------------
async function ask(text) {
  const q = (text ?? $('input').value).trim();
  if (!q) return;
  $('input').value = '';
  add('me', q);
  const thinking = add('ai', '…');
  try {
    const scan = await tabSend('SCAN_FIELDS');
    const fields = (scan && scan.ok && scan.fields) || [];
    const r = await bg('ASSIST_COMMAND', { instruction: q, fields });
    thinking.remove();
    if (!r || !r.ok) return void add('ai', '⚠ ' + (r ? r.error : 'request failed'));
    const d = r.data || {};
    if (d.action === 'fill' && d.field) {
      const fr = await tabSend('FILL_FIELD', { label: d.field, value: d.value });
      add('ai', fr.ok ? `✓ Filled "${fr.label}" with "${d.value}"` : `⚠ ${fr.error}`);
    } else if (d.action === 'answer') {
      add('ai', d.value || '(no answer)', [
        ['📋 Copy', () => navigator.clipboard.writeText(d.value || '')],
        ['💾 Save to autofill', async () => { await bg('SAVE_QA', { question: q, answer: d.value }); add('ai', 'Saved to your autofill answers ✓'); }],
      ]);
    } else if (d.action === 'save') {
      add('ai', 'Saved to your autofill answers ✓');
    } else {
      add('ai', d.message || 'Done.');
    }
  } catch (e) {
    thinking.remove();
    add('ai', '⚠ ' + e.message);
  }
}
$('send').onclick = () => ask();
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
document.querySelectorAll('.hint').forEach((h) => h.addEventListener('click', () => ask(h.textContent)));

loadProfile();
