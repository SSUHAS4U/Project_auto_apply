# Browser extension guide

The JobPilot extension does two things, and **never submits a form for you**:
1. **Autofill** Google Forms, Microsoft Forms, and generic ATS/job forms from your profile.
2. **Capture** ("Save to JobPilot") job listings from LinkedIn / Naukri / Indeed into your tracker.

## Install (unpacked)
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the [`extension/`](../extension/) folder.
3. Click the JobPilot toolbar icon → **Options** → set **Backend URL** + **API token** → **Test connection**.

Works in Chrome, Edge, and Brave.

## On/off toggle
The popup header has a **power switch**. Off = JobPilot injects nothing into pages (no Save
button, no ✨ toolbars) and every fill/save action refuses until you switch it back on.
The setting persists in `chrome.storage.local` and applies to all tabs immediately.

## Autofill a form
1. Open a Google Form / MS Form / application page.
2. Click the JobPilot icon → **⚡ Fill this form**.
3. Filled fields are highlighted; a badge shows *"filled N of M — review & submit"*.
4. Review everything, then submit yourself.

The fill is **two-pass and adaptive**: a fast synonym pass fills standard profile fields, then an
AI pass reads the remaining labels (dropdowns, typeaheads and custom widgets included) and fills
them from your full profile. Afterwards the popup shows a **fill report** listing every field that
still needs you, with the exact reason:
- *No info in your JobPilot profile* → add the value in Profile, or save an answer in the Q&A bank.
- *Your profile's "X" is empty* → that one profile field is missing — fill it and refill.
- *Value ready but the control resisted autofill* → the value is shown; set it manually.
- *Couldn't read a label* → the form hides its label; use the side-panel copilot.

How matching works (`content/common/fieldEngine.js`):
- Derives a label per field from `<label>`, `aria-label`, placeholder, name, or nearby text.
- Matches the label against a **synonym dictionary** → profile key (name, email, phone, location, links…).
- Custom mappings: add entries to your profile's `field_map` (label keyword → value) for site-specific questions.
- Values are set with native setters + `input`/`change` events so React/Angular/Vue forms register them.

## Save a listing
On a LinkedIn/Naukri/Indeed job page a **🔖 Save to JobPilot** button appears (bottom-left), or use the
popup's **Save this listing**. The listing (title/company/location/url) is pushed to `/api/extension/saved-job`.
Promote it to a tracked application from the dashboard's **Saved** page.

## Maintenance note
Per-site selectors (`content/sites/linkedin.js`, `naukri.js`, `indeed.js`) depend on each site's markup
and will occasionally break when the sites change. Update the `extract()` selectors in the relevant file;
the generic label matcher keeps standard fields (name/email/phone) working in the meantime.
