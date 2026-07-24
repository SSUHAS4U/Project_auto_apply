const $ = (id) => document.getElementById(id);

function bg(type, payload) {
  return new Promise((r) => chrome.runtime.sendMessage({ type, ...payload }, r));
}
// --- multi-frame messaging ---------------------------------------------------
// Application forms are very often inside an IFRAME (embedded Greenhouse/Workday/
// SmartRecruiters on company career pages). Content scripts now run in all frames;
// here we message EVERY frame and merge the results, instead of letting an empty
// top frame answer first and mask the frame that actually holds the form.

function activeTab() {
  return new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, ([t]) => res(t || null)));
}
function frameList(tabId) {
  return new Promise((res) => {
    try {
      chrome.webNavigation.getAllFrames({ tabId }, (fs) => {
        if (chrome.runtime.lastError || !fs || !fs.length) return res([{ frameId: 0 }]);
        res(fs);
      });
    } catch (_) { res([{ frameId: 0 }]); }
  });
}
function sendToFrame(tabId, frameId, message) {
  return new Promise((res) => {
    try {
      chrome.tabs.sendMessage(tabId, message, { frameId }, (resp) => {
        if (chrome.runtime.lastError || !resp) return res(null);
        res({ ...resp, frameId });
      });
    } catch (_) { res(null); }
  });
}

let lastPlanFrameId = 0; // the frame the last PLAN_FILL came from — APPLY goes back there

async function tabSend(type, payload = {}) {
  const tab = await activeTab();
  if (!tab) return { ok: false, error: 'no active tab' };

  // APPLY_FILL must hit the exact frame that produced the plan (ids are per-frame).
  if (type === 'APPLY_FILL') {
    const r = await sendToFrame(tab.id, lastPlanFrameId, { type, ...payload });
    return r || { ok: false, error: 'The form frame changed — run Scan & review again.' };
  }

  const frames = await frameList(tab.id);
  const results = (await Promise.all(
    frames.map((f) => sendToFrame(tab.id, f.frameId, { type, ...payload })),
  )).filter(Boolean);
  if (!results.length) return { ok: false, error: 'No JobPilot on this page (try reloading it)' };
  const oks = results.filter((r) => r.ok);
  if (!oks.length) return results[0];

  switch (type) {
    case 'FILL':
    case 'AI_FILL': {
      const agg = { ok: true, filled: 0, total: 0, report: [] };
      oks.forEach((r) => { agg.filled += r.filled || 0; agg.total += r.total || 0; if (r.report) agg.report.push(...r.report); });
      return agg;
    }
    case 'AUTO_ANSWER': {
      const agg = { ok: true, done: 0, total: 0 };
      oks.forEach((r) => { agg.done += r.done || 0; agg.total += r.total || 0; });
      return agg;
    }
    case 'PLAN_FILL': {
      const best = oks.reduce((a, b) => (((b.plan || []).length > (a.plan || []).length) ? b : a));
      lastPlanFrameId = best.frameId ?? 0;
      return best;
    }
    case 'EXTRACT_JD':
      return oks.reduce((a, b) => (((b.jdText || '').length > (a.jdText || '').length) ? b : a));
    case 'UPLOAD_RESUME':
    case 'ATTACH_COVER_LETTER':
      return oks.find((r) => r.attached) || oks.find((r) => r.pickerOpened) || oks[0];
    case 'SCAN_FIELDS':
      return { ok: true, fields: [...new Set(oks.flatMap((r) => r.fields || []))] };
    default:
      return oks.find((r) => r.frameId === 0) || oks[0];
  }
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
// --- Fill now (same engine as Scan & review, just no review step) ------------
// Previously "Quick fill" chained three different fillers: the old keyword matcher (FILL),
// then AI_FILL, then AUTO_ANSWER. Because every AI filler skips fields that already hold a
// value, a wrong keyword guess from step 1 permanently BLOCKED the AI from correcting it —
// the three were fighting each other. There is now exactly one brain: build the plan, apply it.
$('fillnow').onclick = async () => {
  add('me', 'Fill this form');
  const prog = add('ai', '⏳ Reading every question and preparing answers…');
  await bg('GET_PROFILE', { force: true });
  const r = await tabSend('PLAN_FILL');
  if (!r.ok) { prog.remove(); return void add('ai', '⚠ ' + r.error); }
  const items = (r.plan || []).filter((f) => String(f.value || '').trim());
  if (!items.length) { prog.remove(); return void add('ai', 'Nothing to fill here — every field already has a value.'); }
  prog.textContent = `⏳ Filling ${items.length} field${items.length === 1 ? '' : 's'}…`;
  const res = await tabSend('APPLY_FILL', { items: items.map((f) => ({ id: f.id, label: f.label, value: f.value })) });
  prog.remove();
  if (!res.ok) return void add('ai', '⚠ ' + res.error);
  let m = `✓ Filled ${res.applied} of ${items.length} — review the page & submit yourself.`;
  const skipped = (r.plan || []).length - items.length;
  if (skipped > 0) m += `
${skipped} question${skipped === 1 ? '' : 's'} had no answer — use Scan & review to fill them in.`;
  if (res.failed && res.failed.length) m += `
⚠ Couldn't set: ${res.failed.slice(0, 5).join('; ')}.`;
  add('ai', m);
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

// --- Auto Apply queue -------------------------------------------------------
// The daily Auto Apply engine queues ATS/portal jobs it can't legally submit
// server-side. Walk the queue here: open a job, hit Quick fill, submit, then
// mark it ✓ so it lands in Applications.
$('queue').onclick = async () => {
  add('me', 'Show my Auto Apply queue');
  const r = await bg('AUTO_APPLY_QUEUE', {});
  if (!r || !r.ok) return void add('ai', '⚠ ' + (r ? r.error : 'background unavailable'));
  const items = r.data || [];
  if (!items.length) return void add('ai', 'Queue is empty ✓ — the next daily run will refill it.');
  add('ai', `⚡ ${items.length} job${items.length === 1 ? '' : 's'} queued. Open one, hit Fill now, submit, then mark it ✓.`);
  items.slice(0, 10).forEach((it) => {
    const title = `${it.title || 'Job'}${it.company ? ' @ ' + it.company : ''}${it.matchScore != null ? ` (match ${it.matchScore})` : ''}`;
    add('ai', title, [
      ['↗ Open & fill', async () => {
        await bg('AUTO_APPLY_QUEUE_STATUS', { itemId: it.id, status: 'opened' });
        chrome.tabs.create({ url: it.url });
      }],
      ['✓ Applied', async () => {
        const res = await bg('AUTO_APPLY_QUEUE_STATUS', { itemId: it.id, status: 'applied' });
        add('ai', res && res.ok ? 'Marked applied — added to Applications ✓' : '⚠ ' + (res ? res.error : 'failed'));
      }],
      ['✕ Dismiss', async () => {
        await bg('AUTO_APPLY_QUEUE_STATUS', { itemId: it.id, status: 'dismissed' });
        add('ai', 'Dismissed.');
      }],
    ]);
  });
  if (items.length > 10) add('ai', `…and ${items.length - 10} more — manage the full queue in Dashboard → Auto Apply.`);
};
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
