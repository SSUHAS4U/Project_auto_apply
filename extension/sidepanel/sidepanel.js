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
  const text = ok ? `connected · ${r.data.full_name || 'signed in'}` : (r ? r.error : 'sign in via Options');
  $('conn').innerHTML = '<span class="dot"></span>';
  $('conn').appendChild(document.createTextNode(text));
  $('conn').className = 'sub ' + (ok ? 'ok' : 'err');
}

// --- global on/off toggle --------------------------------------------------
function applyEnabledUi(on) {
  $('power').checked = on;
  document.querySelectorAll('.actions .btn').forEach((b) => { b.disabled = !on; });
}
chrome.storage.local.get({ jobpilotEnabled: true }, (v) => applyEnabledUi(v.jobpilotEnabled !== false));
$('power').addEventListener('change', () => {
  const on = $('power').checked;
  chrome.storage.local.set({ jobpilotEnabled: on });
  applyEnabledUi(on);
  add('ai', on ? 'JobPilot is back on ✓' : 'JobPilot is off — pages stay untouched until you switch it back on.');
});

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
// --- Scan & review, then fill ----------------------------------------------
// PLAN_FILL returns every empty field with a proposed answer + where it came from.
// The user edits inline (text/selects), regenerates single answers with ✨, and
// nothing touches the page until ✅ Apply.
$('review').onclick = async () => {
  add('me', 'Scan & review this form');
  const prog = add('ai', '⏳ Scanning the form and preparing an answer for every field…');
  await bg('GET_PROFILE', { force: true });
  const r = await tabSend('PLAN_FILL');
  prog.remove();
  if (!r.ok) return void add('ai', '⚠ ' + r.error);
  if (!r.plan || !r.plan.length) return void add('ai', 'No empty fillable fields found here — everything may already be filled.');
  renderPlan(r.plan);
};

const SRC_LABEL = { profile: '👤 profile', ai: '✨ AI', '': '⚠ no answer' };

function renderPlan(plan) {
  const card = add('ai', '');
  card.classList.add('plan');
  const head = document.createElement('div');
  head.className = 'plan-head';
  head.textContent = `📋 Found ${plan.length} field${plan.length === 1 ? '' : 's'} to fill. ` +
    'Check each answer (👤 = from your profile, ✨ = AI), edit anything, then Apply.';
  card.appendChild(head);

  const inputs = new Map(); // id → input/select
  plan.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'plan-row';

    const top = document.createElement('div');
    top.className = 'plan-top';
    const label = document.createElement('div');
    label.className = 'plan-label';
    label.textContent = f.label;
    label.title = f.label;
    const src = document.createElement('span');
    src.className = 'plan-src' + (f.source ? '' : ' warn');
    src.textContent = SRC_LABEL[f.source] ?? f.source;
    top.append(label, src);

    let input;
    if (f.options && f.kind !== 'checkbox') {
      input = document.createElement('select');
      input.className = 'plan-input';
      const empty = document.createElement('option');
      empty.value = ''; empty.textContent = '— skip this field —';
      input.appendChild(empty);
      f.options.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o; opt.textContent = o;
        if (f.value && (o.toLowerCase() === f.value.toLowerCase() || o.toLowerCase().includes(f.value.toLowerCase()))) opt.selected = true;
        input.appendChild(opt);
      });
    } else {
      input = document.createElement(f.kind === 'question' ? 'textarea' : 'input');
      input.className = 'plan-input';
      if (f.kind === 'question') input.rows = 3;
      input.value = f.value;
      input.placeholder = f.kind === 'checkbox' ? 'comma-separated choices, or empty to skip' : 'empty = skip this field';
    }
    inputs.set(f.id, input);

    const regen = document.createElement('button');
    regen.className = 'plan-regen';
    regen.title = 'Ask the AI again for this field';
    regen.textContent = '✨';
    regen.onclick = async () => {
      regen.disabled = true; regen.textContent = '…';
      try {
        if (f.options) {
          const c = await bg('ASSIST_CHOOSE', { question: f.label, options: f.options, multi: f.kind === 'checkbox' });
          const sel = ((c && c.data && c.data.selected) || (c && c.selected) || []).join(', ');
          if (sel) { input.value = sel; src.textContent = SRC_LABEL.ai; src.classList.remove('warn'); }
        } else {
          const a = await bg('ASSIST_ANSWER', { question: f.label });
          const ans = (a && a.data && a.data.answer) || (a && a.answer);
          if (ans) { input.value = ans; src.textContent = SRC_LABEL.ai; src.classList.remove('warn'); }
        }
      } finally { regen.disabled = false; regen.textContent = '✨'; }
    };

    const line = document.createElement('div');
    line.className = 'plan-line';
    line.append(input, regen);
    row.append(top, line);
    card.appendChild(row);
  });

  const foot = document.createElement('div');
  foot.className = 'plan-foot';
  const apply = document.createElement('button');
  apply.className = 'plan-apply';
  apply.textContent = `✅ Apply ${plan.length} answers`;
  apply.onclick = async () => {
    apply.disabled = true; apply.textContent = '⏳ Applying…';
    const items = plan.map((f) => ({ id: f.id, value: inputs.get(f.id).value }));
    const res = await tabSend('APPLY_FILL', { items });
    apply.remove(); cancel.remove();
    if (!res.ok) return void add('ai', '⚠ ' + res.error);

    // LEARN from corrections: any answer the user edited becomes a saved Q&A, so the
    // same question is answered THEIR way (bank first) on every future form.
    let learned = 0;
    for (const f of plan) {
      const finalV = (inputs.get(f.id).value || '').trim();
      if (finalV && finalV !== (f.value || '').trim() && finalV.length <= 1500) {
        try { await bg('SAVE_QA', { question: f.label, answer: finalV }); learned++; } catch (_) { /* skip */ }
      }
    }

    let msgTxt = `✓ Applied ${res.applied} answer${res.applied === 1 ? '' : 's'} — review the page & submit yourself.`;
    if (learned) msgTxt += `\n🧠 Learned ${learned} corrected answer${learned === 1 ? '' : 's'} — I'll use them automatically next time.`;
    if (res.failed && res.failed.length) {
      msgTxt += `\n⚠ Couldn't set: ${res.failed.slice(0, 5).join('; ')}${res.failed.length > 5 ? '…' : ''} — set those manually.`;
    }
    add('ai', msgTxt);
  };
  const cancel = document.createElement('button');
  cancel.className = 'plan-cancel';
  cancel.textContent = 'Discard';
  cancel.onclick = () => { card.remove(); add('ai', 'Plan discarded — nothing was filled.'); };
  foot.append(apply, cancel);
  card.appendChild(foot);
  $('chat').scrollTop = $('chat').scrollHeight;
}

$('answer').onclick = async () => {
  add('me', 'AI-answer questions');
  const r = await tabSend('AUTO_ANSWER');
  add('ai', r.ok ? (r.total ? `Answered ${r.done} of ${r.total} questions — review them.` : 'No open-ended question fields found here.') : '⚠ ' + r.error);
};
// Resume picker: always ask WHICH resume to attach (profile + LaTeX builder PDFs).
$('resume').onclick = async () => {
  const r = await bg('LIST_RESUMES', {});
  if (!r || !r.ok) return void add('ai', '⚠ ' + (r ? r.error : 'background unavailable'));
  const options = (r.data || []).filter((o) => o.hasPdf);
  if (!options.length) {
    return void add('ai', 'No resume PDFs yet — upload one in Profile, or compile one in Dashboard → Resumes.');
  }
  add('ai', 'Which resume should I attach?', options.map((o) => [
    `${o.base ? '⭐ ' : ''}${o.name}`,
    async () => {
      add('me', `Attach "${o.name}"`);
      const res = await tabSend('UPLOAD_RESUME', o.id ? { docId: o.id } : {});
      if (!res.ok) return void add('ai', '⚠ ' + res.error);
      add('ai', res.attached ? `Resume attached (${res.filename}) ✓` : (res.note || 'Downloaded your resume.'));
    },
  ]));
};

// Grab this page's JD → AI-tailored copy of the base resume → open the editor.
$('tailor').onclick = async () => {
  add('me', 'Tailor resume to this job');
  const jd = await tabSend('EXTRACT_JD');
  if (!jd.ok) return void add('ai', '⚠ ' + jd.error);
  if (!jd.jdText || jd.jdText.length < 80) return void add('ai', '⚠ Couldn’t find a job description on this page.');
  const name = [jd.role, jd.company].filter(Boolean).join(' – ').slice(0, 80) || 'Tailored resume';
  const prog = add('ai', '⏳ Tailoring a copy of your base resume to this JD…');
  const r = await bg('TAILOR_RESUME', { name, jobUrl: jd.url, jdText: jd.jdText });
  prog.remove();
  add('ai', r && r.ok
    ? `✓ Created "${name}" — opened the editor. Review, compile, and it'll appear in 📎 Resume.`
    : '⚠ ' + ((r && r.error) || 'tailor failed'));
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
