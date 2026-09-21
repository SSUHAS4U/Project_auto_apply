# JobPilot — UI spec

The agreed look, and where it came from. Read this before any UI change; it exists so the same
decisions are not re-derived every session.

Approved mockups (2026-09-21): https://claude.ai/artifact/Kz5HbKUB5StoNW1ts1ZnLk — home page,
sign-up / log-in, the three match-score options (A was chosen), job cards, profile, dashboard,
auto apply, fields and controls, the dock, mobile.

---

## Product references

Agreed 2026-09-21, replacing the 2026-09-14 Linear anchor. **Ashby** is the anchor.

| Reference | Captured | Why this one |
|---|---|---|
| **Ashby** (ashbyhq.com) | `~/.claude/design-library/notes/ashby.md` | Recruiting software people pay for: the owner asked for "a professional auto-apply website" that doesn't look AI-made. |
| **Huntr** (huntr.co) | `~/.claude/design-library/notes/huntr.md` | A job-seeker product — outcome-first copy, a tracker by status. What NOT to take: its confetti shapes. |
| Linear — Method | `~/.claude/design-library/notes/linear.md` | Still the reference for restraint in dense settings surfaces. |

---

## REFERENCE NOTES

```
Source           Decision replicated
Ashby/home       One heavy headline carries the page; nothing competes with it.
Ashby/home       "Log in" is a TEXT link beside ONE filled button. Never two buttons.
Ashby/home       Social proof is a flat row of logos — here, the real job sources — no cards.
Ashby/home       Feature sections are big white cards on an off-white canvas, hairline + faint shadow.
Ashby/home       ONE saturated colour. Everything else black / grey.
Huntr/home       Outcome-first headline; a real product fragment beside it, not an illustration.
Linear/Method    Emphasis from WEIGHT and SIZE, never from colour.
Linear/Method    A border only where two different kinds of thing meet.
```

### What this rules out

Indigo gradients (every one was removed), colour as decoration (eight tile colours on one
dashboard), a card for every number, emoji as icons — in the app and in the extension.

---

## Tokens

`frontend/src/styles.css`, top of file. Light is the default; dark is designed alongside, not
inverted. The legacy names (`--bg`, `--bg-card`, `--text-dim`, `--green`, …) are ALIASES of the
roles below, so every older component re-skinned from the one block.

| Role | Light | Dark | Used for |
|---|---|---|---|
| `--canvas` / `--surface` / `--surface-2` / `--sunken` | `#F4F5F7` / `#FFF` / `#FAFBFC` / `#EEF0F3` | `#0C0E11` / `#14171C` / `#181B21` / `#0F1115` | page, cards, raised rows, wells |
| `--line` / `--line-strong` | `#E3E6EB` / `#CDD2DA` | `#252A32` / `#353B45` | hairlines, control borders |
| `--ink` / `--ink-2` / `--ink-3` | `#0F1217` / `#4A5260` / `#737C8A` | `#ECEEF2` / `#A6ADB8` / `#7D8592` | heading / body / meta — a three-step ladder, nothing more |
| `--primary` / `--on-primary` | ink / white | white / ink | THE primary action, the logo tile, the dock highlight |
| `--accent` | `#2152D9` | `#7FA2FF` | links, the active nav icon, focus rings. Never a button fill. |
| `--success` / `--warning` / `--danger` (+ `-soft`) | | | real state only |

- **No raw hex in a component.** The one exception is the logo tile's white background: logos
  are drawn for white.
- Type: **Onest** for the interface, **Geist Mono** for numbers (`tabular-nums`).
- Radius: 14 (card) / 9 (control) / 6 (chip). Controls are 36–38px; card actions are 36px.
- Motion: 160 ms, one curve (`--ease`); `prefers-reduced-motion` disables it.

### Colour budget per surface

| Colour | Means |
|---|---|
| Ink fill | the one primary action |
| Blue (accent) | a link, where you are, where focus is — and "applied, waiting" in status dots |
| Green | a good outcome: applied, connected, tracked, a great fit |
| Amber | needs you: an unanswered question, a fair fit |
| Red | a real problem: signed out, failed, a weak fit |
| Everything else | greys |

---

## Match score — the fit scale

`components/FitScale.tsx`, bands in `lib/fit.ts` (the ONLY place the thresholds live).

```
 74 /100      [Good fit]        number · verdict WORD (colour is never the only carrier)
 ▒▒▒▒▒▒▒▒ ▒▒ ████▌░░░░          four bands at their REAL widths, marker at the score
 weak <40  fair <55  good <75  great
```

Hover or keyboard focus opens the reasons: skills matched of total, experience the posting asks,
location, what's missing. Rows appear only for facts the posting gave. On narrow cards the scale
becomes a full-width bar under the title. `MiniFit` is the compact form for tables and lists.

---

## One job card, everywhere

`components/JobCardV2.tsx`. Logo · title/company · fit scale; facts; skills; then ONE bottom row
— source + apply-method tag on the left, every control on the right at 36px. The status dropdown
and "Tracked" sit in that row beside Details; they looked misplaced when they hugged their text
in a narrow side column between full-width panels.

- A fact the posting doesn't state is **left out** — never "Not mentioned".
- Missing skills are a dashed outline (a gap to fill), not red (an error).
- Logos: by the company's **domain** when the job link is on its own site, then by company name,
  then the initial. Never by job title. See `lib/companyDomain.ts`.

---

## Shell

- Sidebar: logo + name, five modules, the active one a raised white row with a blue icon; one
  footer row — avatar, name, email, bell, theme, sign out.
- **The bottom dock keeps its shape, glass and sliding motion**; only its colours follow the
  theme — the sliding highlight is `--primary`.
- Pages are size containers (`.page { container-type: inline-size }`), so cards reflow on the
  width they actually get. A full-page layout (home, auth) uses media queries — an element can't
  query its own size.

---

## Public pages

- `/` signed out on the web, and `/welcome` always: the home page. The desktop app skips it.
- `/login`, `/register`: split layout. The Google button renders only when the server reports a
  client id AND this is a browser. Register asks the server whether sign-up is open and shows an
  invite-only explanation when it isn't.
- Every claim on the home page is something the product does. No user counts, ratings or quotes.

---

## Extension

Popup, side panel, the on-page pill and the "Save to JobPilot" button use the same tokens,
following the browser's light/dark setting (they can't see the dashboard's toggle). The pill's
collapsed handle is the "J" mark; expanded it is `AI answer` (primary) · `Save` · a status note.
Shared through `content/common/jpUi.js`. SVG icons only.

---

## Density

`comfortable` on settings and profile surfaces; `compact` on tables and the job board.

---

## Verification

`frontend/test/responsive.test.mjs` renders every route (including `/welcome`, `/login`,
`/register`) at 360 / 768 / 1280 in both themes against empty AND populated fixtures, and fails on
horizontal page scroll or any element escaping the viewport. A UI change is not done until that
suite passes and the screenshots have been looked at.

Found by that discipline during the redesign, so they aren't reintroduced:

- A `visibility:hidden` popover still counts toward the page's scroll width. Hidden-until-hover
  UI must be `display:none` until shown.
- Two components sharing a class name (`.flow-step`) — new global classes need a unique prefix.
