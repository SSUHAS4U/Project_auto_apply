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
// One click = a COMPLETE pass: profile text fields, selects, custom dropdowns, then every
// radio / checkbox / open-ended question — all in sequence so they never race each other.
$('fill').onclick = async () => {
  add('me', 'Fill this form');
  const prog = add('ai', '⏳ Starting…');
  const setProg = (t) => { prog.textContent = t; $('chat').scrollTop = $('chat').scrollHeight; };
  await bg('GET_PROFILE', { force: true }); // refresh cache so recent profile edits are used
  let filled = 0, answered = 0, anyOk = false, firstErr = '';
  const step = async (type, label) => {
    setProg(label);
    const r = await tabSend(type);
    if (r.ok) anyOk = true; else firstErr = firstErr || r.error;
    return r;
  };
  const f1 = await step('FILL', '⏳ Filling your details…'); if (f1.ok) filled += f1.filled || 0;
  const f2 = await step('AI_FILL', `⏳ Filling dropdowns & smart fields… (${filled} so far)`); if (f2.ok) filled += f2.filled || 0;
  const a = await step('AUTO_ANSWER', `⏳ Answering questions… (${filled} fields filled)`); if (a.ok) answered += a.done || 0;
  prog.remove();
  if (!anyOk) return void add('ai', '⚠ ' + (firstErr || 'No JobPilot on this page — reload the page and retry'));
  const parts = [];
  if (filled) parts.push(`${filled} field${filled === 1 ? '' : 's'}`);
  if (answered) parts.push(`${answered} question${answered === 1 ? '' : 's'}`);
  add('ai', parts.length ? `✓ Filled ${parts.join(' + ')} — review & submit.` : '✓ Everything was already filled — review & submit.');
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
      const cleanQ = d.question || q; // the extracted form question, not the chat instruction
      add('ai', d.value || '(no answer)', [
        ['📋 Copy', () => navigator.clipboard.writeText(d.value || '')],
        ['💾 Save to autofill', async () => { await bg('SAVE_QA', { question: cleanQ, answer: d.value }); add('ai', `Saved "${cleanQ}" ✓`); }],
      ]);
    } else if (d.action === 'save') {
      // backend already persisted it; show the clean question that was saved
      add('ai', `Saved ${d.question ? `"${d.question}"` : 'this'} to your autofill answers ✓`);
    } else if (d.action === 'save_job') {
      const sr = await tabSend('SAVE_CURRENT');
      add('ai', sr.ok ? 'Saved this job to your tracker ✓' : '⚠ ' + (sr.error || 'could not save — reload the page and retry'));
    } else {
      add('ai', d.message || 'Done.');
    }
  } catch (e) {
    thinking.remove();
    add('ai', '⚠ ' + e.message);
  }
}
$('send').onclick = () => ask();
// Enter sends; Shift+Enter inserts a new line. Auto-grow the textarea up to its max height.
const inputEl = $('input');
const autoGrow = () => { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'; };
inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); inputEl.style.height = 'auto'; }
});
document.querySelectorAll('.hint').forEach((h) => h.addEventListener('click', () => ask(h.textContent)));

loadProfile();
