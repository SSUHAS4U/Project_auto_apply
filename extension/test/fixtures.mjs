// Real DOM shapes, copied in structure from the ATS platforms that matter.
//
// These are fixtures, not mocks: each one reproduces the markup pattern the real product uses —
// Workday's data-automation-id typeahead, Microsoft Forms' title-in-a-span with a generic
// aria-label, Google Forms' role=listitem, the table-grid wizard, the same-origin iframe that
// Greenhouse and Lever render into. If the engine handles these, the site is irrelevant to it,
// which is the whole point of removing the per-site adapters.

/** Workday: custom typeahead widgets keyed by data-automation-id, labels as preceding siblings. */
export const workday = `
<div data-automation-id="applicationPage">
  <div class="field">
    <label id="lbl-fn">First Name</label>
    <input data-automation-id="legalNameSection_firstName" aria-labelledby="lbl-fn" />
  </div>
  <div class="field">
    <label id="lbl-ln">Last Name</label>
    <input data-automation-id="legalNameSection_lastName" aria-labelledby="lbl-ln" />
  </div>
  <div class="field">
    <label id="lbl-country">Country</label>
    <input data-automation-id="countryDropdown" role="combobox"
           aria-haspopup="listbox" aria-labelledby="lbl-country" aria-autocomplete="list" />
  </div>
  <div class="field">
    <label id="lbl-email">Email Address</label>
    <input type="email" data-automation-id="email" aria-labelledby="lbl-email" required />
  </div>
</div>`;

/**
 * THE regression fixture. One section heading, one wrapping div, three inputs.
 *
 * The old deriveQuestion did el.closest('div') then took the first heading inside it, so all
 * three fields were labelled "10TH ACADEMIC DETAILS" — the bug behind "the AI answer reads the
 * wrong question". Each input here has its own label; the engine must return three DIFFERENT
 * labels and never the section heading.
 */
export const sharedLabel = `
<div class="section">
  <h3>10TH ACADEMIC DETAILS</h3>
  <div class="row">
    <div><label for="a1">School Name</label><input id="a1" /></div>
    <div><label for="a2">Board</label><input id="a2" /></div>
    <div><label for="a3">Percentage</label><input id="a3" /></div>
  </div>
</div>`;

/** Microsoft Forms: no <label> anywhere; title is a span, input carries a generic aria-label. */
export const msForms = `
<div data-automation-id="questionItem">
  <span class="text-format-content">What is your full name?</span>
  <input aria-label="Enter your answer" type="text" />
</div>
<div data-automation-id="questionItem">
  <span class="text-format-content">Your Email ID</span>
  <input aria-label="Enter your answer" type="text" />
</div>`;

/** Google Forms: role=listitem blocks, role=heading titles, ARIA radios. */
export const googleForms = `
<div role="listitem">
  <div role="heading">Why do you want this role?</div>
  <textarea aria-label="Your answer"></textarea>
</div>
<div role="listitem">
  <div role="heading">Are you willing to relocate?</div>
  <div role="radiogroup" aria-label="Are you willing to relocate?">
    <label><input type="radio" name="reloc" value="y" /> Yes</label>
    <label><input type="radio" name="reloc" value="n" /> No</label>
  </div>
</div>`;

/** Table-grid wizard: the question lives in the column header, not beside the input. */
export const grid = `
<table>
  <thead><tr><th>Qualification</th><th>Institute</th><th>Year of Passing</th></tr></thead>
  <tbody>
    <tr><th>B.Tech</th><td><input id="g1" /></td><td><input id="g2" /></td></tr>
  </tbody>
</table>`;

/** Greenhouse / Lever: the whole form inside a same-origin iframe. */
export const iframeForm = `
<h1>Apply</h1>
<iframe id="gh" srcdoc='
  <div><label for="n">Full name</label><input id="n" /></div>
  <div><label for="e">Email</label><input id="e" type="email" /></div>
'></iframe>`;

/** Every control kind at once, plus the two visibility traps. */
export const controls = `
<div><label for="s1">Highest Qualification</label>
  <select id="s1">
    <option value="">Please select</option>
    <option>Bachelors</option>
    <option>Masters</option>
  </select>
</div>
<fieldset>
  <legend>Do you require visa sponsorship?</legend>
  <label><input type="radio" name="visa" value="yes" /> Yes</label>
  <label><input type="radio" name="visa" value="no" /> No</label>
</fieldset>
<fieldset>
  <legend>Which languages do you know?</legend>
  <label><input type="checkbox" name="lang" value="java" /> Java</label>
  <label><input type="checkbox" name="lang" value="python" /> Python</label>
  <label><input type="checkbox" name="lang" value="go" /> Go</label>
</fieldset>
<div><label for="d1">Available from</label><input id="d1" type="date" /></div>
<div><label for="c1">Cover note</label><div id="c1" contenteditable="true"></div></div>
<div style="position:fixed;top:0"><label for="f1">Phone</label><input id="f1" type="tel" /></div>
<div style="display:none"><label for="h1">Hidden field</label><input id="h1" /></div>`;

/** An open shadow root holding the control. */
export const shadow = `
<div id="host"></div>
<script>
  const r = document.getElementById('host').attachShadow({ mode: 'open' });
  r.innerHTML = '<div><label for="sx">LinkedIn Profile</label><input id="sx" /></div>';
</script>`;

/** A React-style controlled input: ignores el.value = x, only respects the native setter. */
export const controlled = `
<div><label for="r1">Current Company</label><input id="r1" /></div>
<script>
  const el = document.getElementById('r1');
  let internal = '';
  const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  Object.defineProperty(el, 'value', {
    get() { return internal; },
    set(v) { internal = v; d.set.call(el, v); },
    configurable: true,
  });
  el.addEventListener('input', () => { window.__reactSaw = el.value; });
</script>`;
