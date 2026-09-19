# JobPilot — architecture

A file-by-file map of what owns what, the invariants any rewrite must keep, and the failure
modes that have actually happened. Read this before changing anything. If it is wrong, fix it in
the same commit as the change that made it wrong.

`docs/AUTOMATION.md` is the incident log — *why* things are the way they are. This file is the map —
*what things are*. Neither replaces the other.

---

## 1. The four executables

| Piece | Lives in | Runs where | Ships how |
|---|---|---|---|
| **Backend** | `backend/` (Spring Boot, Java 21) | GCP e2-micro VM, `35.212.189.37.sslip.io`, behind Caddy | push to `master` → GHCR image → compose rollout |
| **Dashboard** | `frontend/` (React + Vite + TS) | Vercel, and bundled into desktop | push to `master` (web) / `desktop-v*` tag (desktop) |
| **Worker** | `worker/` (Node + playwright-core) | the owner's machine, inside the desktop app | `desktop-v*` tag only |
| **Extension** | `extension/` (MV3, vanilla JS) | the owner's Chrome | zipped in the frontend build |

**The deploy asymmetry is the most common way a "fix" fails to reach the owner.** The backend
redeploys on push; the worker and dashboard reach desktop users **only** through a `desktop-v*`
tag. A web refresh cannot update the desktop app. See `CLAUDE.md` → Shipping.

---

## 2. Backend — `backend/src/main/java/com/jobpilot/`

| Package | Lines | Owns |
|---|---|---|
| `service/` | 7.9k | Everything that isn't a run: profile, résumés, assist/AI, compose, settings, secrets, mail |
| `agent/` | 4.5k | Scheduling, runs, events, contacts, fit verdicts, follow-ups |
| `engine/` | 2.8k | The apply / rank / interview / upskill / setup pipelines |
| `pilot/` | 1.7k | Draft → review → compile-verify document generation |
| `web/` | 1.4k | REST controllers only. No logic. |
| `connector/` | 1.3k | Job-board feeds (Careerjet, Jooble, IndianAPI, the keyless aggregators, …) |
| `domain/` + `repository/` | 1.2k | JPA entities and Spring Data repositories |
| `security/` | 0.4k | `AuthFilter` (JWT for users, static token for admin, worker tokens), CORS |
| `config/` | 0.4k | `JobPilotProperties` (all tunables), `WebConfig` (the one shared `RestClient`) |

### Invariant: every LLM call goes through `AiService`

`service/ai/` is the only package allowed to touch a provider client. Enforced by
`AiRoutingGuardTest`, which reads the source tree — a service that injected `GroqAiClient`
directly would keep working, keep passing its own tests, and silently ignore the user's provider
choice, the rotation, the rate-limit cooldown and the daily cap.

```
caller → AiService.complete(system, user, fast, cacheable, maxTokens)
           ├── provider rotation (auto = both free tiers take turns)
           ├── cooldown (a 429'd provider goes to the back, never out)
           ├── LRU cache (deterministic tasks only — never chat)
           └── GroqAiClient | GeminiAiClient
                 ├── RetiredModels — a known-dead name is never sent
                 └── runtime self-heal — an unknown 404 falls forward once
```

Each client runs **two** models (normal + fast). Each model name has its own free-tier quota
bucket, which is the reason the fast tier exists on both providers rather than one.

### Invariant: the model is chosen in one place

Settings → AI model. The dashboard reads the model name *from the backend*; hard-coding it there
once meant changing a model left the panel naming the old one.

---

## 3. Extension — `extension/`

The piece the owner touches most, and the one with the least structure.

| File | Lines | Owns |
|---|---|---|
| `content/common/assistEngine.js` | 1768 | The ✨ pill, question derivation, AI answer, save-answer, plan-fill, cover letter, listing scan |
| `content/common/fieldEngine.js` | 365 | `window.JobPilot` — label derivation, synonym matching, value setting, the fill entry point |
| `content/common/smartFill.js` | 186 | Trusted-event value setting, shadow-DOM query, ATS fingerprint, typeahead driving |
| `content/sites/*.js` | 17–63 each | Per-ATS adapters; `generic.js` is the fallback |
| `background.js` | 282 | The only place that talks to the backend (`apiFetch`) |
| `sidepanel/`, `popup/`, `options/` | ~800 | UI surfaces |

### How a fill happens today

```
popup "Fill" → background → tabs.sendMessage({type:'FILL'})
  → a site adapter claims it (sets window.__jobpilotHandled), else generic.js
  → JP.fillTextInputs(profile)
      → per input: deriveLabel() → match() against a fixed SYNONYM dictionary
```

### Structural failure modes of that design

These are design consequences, not bugs to patch individually:

1. **The synonym dictionary is a closed set.** A label phrased outside it returns `no-match` and
   the field is left empty. There is no fallback to the AI for a field the dictionary misses.
2. **`fillTextInputs` selects only text-like inputs.** Selects, radios, checkboxes, comboboxes,
   date pickers and file inputs are never touched — which is most of a Workday form.
3. **`offsetParent === null` is used as "hidden".** It is also null for `position: fixed`
   elements, so visible fields get skipped.
4. **No iframe traversal.** Greenhouse and Lever embed their form in an iframe.
5. **One pass, no re-run.** An SPA that renders the next wizard step after the fill gets nothing.
6. **`deriveQuestion` step 5 scans `el.closest('div')`** and takes the first heading-ish element
   inside it. When that div wraps several fields, every one of them gets the same — wrong —
   question. This is why the AI answer "works sometimes".
7. **`/api/assist/answer` receives `{question, fieldType}` only.** `fieldContext()` exists in
   `assistEngine.js` and is sent to `/api/assist/labels`, but never to `/answer` — so when the
   derived question is wrong, the backend has no signal to recover from.
8. **`ALLOW_HOSTS` / `looksLikeApplicationForm()` gate the pill by hostname regex.** An ATS not
   on that list gets nothing unless the URL happens to contain "apply"/"career"/…

---

## 4. Worker — `worker/src/`

`linkedin.js` (2052) and `indeed.js` (1043) are the portal drivers. `browser.js` owns the
playwright session, `fill.js` the form filling, `gate.js` the fit threshold, `fault.js` the
diagnosis registry, `logfile.js` the single log at `%LOCALAPPDATA%\JobPilot\logs\`.

### Invariant: every failure carries its own diagnosis

A failure goes through `fault.js`, which forces three answers: **what** happened (user terms),
**why** (the mechanism), and **what to do** — naming a screen or a file, never "investigate".
A fault id with no registered guidance is itself reported as a bug, and the suite refuses vague
actions.

### Invariant: lint runs before tests

`npm test` is `eslint src test && node --test`. Three consecutive releases shipped code
referencing a variable from another function's scope; all were valid JavaScript, so
`node --check` passed. `no-undef` finds them in under a second. Never make lint optional.

---

## 5. Frontend — `frontend/src/`

Router in `main.tsx`, shell in `components/Layout.tsx`, one API client in `api/client.ts`, one
type barrel in `types/index.ts`.

### The styling problem

**All styling is one 2065-line `styles.css` with 37 media queries across 14 ad-hoc breakpoints**
(480, 520, 560, 620, 640, 700, 720, 860, 900, 920, 1000, 1080, 1100, 1180). There is no token
layer and no shared breakpoint set, so every component was made responsive on its own, at
whatever width its author happened to test.

That is precisely why some components break on some devices: **nothing in the codebase defines
what the device classes are.** Fixing it means a token-first pass — one defined breakpoint
scale, then each component moved onto it — not more one-off media queries.

---

## 6. Where each decision lives

| Decision | Owner |
|---|---|
| Which AI model | Settings → AI model → `AiService` |
| Which model is dead | `service/ai/RetiredModels.java` |
| Whether to apply to a job | `agent/FitService` + `worker/src/gate.js` (one threshold: `fitMin`) |
| What a field should contain | `extension/.../fieldEngine.js` synonyms, then `/api/assist/answer` |
| When a run may start | `agent/` scheduling |
| Anti-spam limits | `agent/OutreachGuard` + `worker/src/ledger.js` |

---

## 7. The one job card

`components/JobCardV2.tsx` is the ONLY job card. It serves the board, Daily picks, Scout, the
portal panels, the Applications tracker and Saved jobs.

A surface that cannot fill it does not get its own card — it gets its data fixed at the source,
or it passes `sparse`. That rule exists because the tracker previously had a desktop table AND a
separate mobile card, and the two had already diverged: the mobile one showed a bare score chip
where the board showed a fit panel. `responsive.test.mjs` asserts `.jc2` renders on all five job
surfaces, so a sixth bespoke card fails the build.

`sparse` means "omit a fact we never collected", not "hide a fact the posting didn't state". A
board listing that states no salary prints *Not mentioned* — that is true about the posting. A
job saved before the extension captured descriptions has nothing to be true or false about, so
its cells are omitted. Both behaviours are asserted separately.

### What feeds it

| Surface | Source of the card's data |
|---|---|
| Board / Daily picks / Scout | `Job` rows — full |
| Applications | `ApplicationView.JobSummary` — projects `description`, `source`, `salaryText`, `postedAt`; without those four the tracker had nothing to derive facts from |
| Saved jobs | `saved_job.description` + `match_score`, captured by the extension since v0.9.26 and scored on capture |

---

## 8. Honest gaps

- The extension fill core is a keyword dictionary, not an engine. §3 lists why that fails.
- The frontend has no design-token layer; responsiveness is per-component and inconsistent.
- `docs/AUTOMATION.md` is gitignored, so the incident history is local-only.
- `engine/` exposes 24 endpoints and the dashboard calls 4. See `docs/adr/ADR-001`.
- 12% of the HTTP surface still has no caller — 17 of 141, all in the LIVE agent/worker/ops
  subsystems, which is why they were not removed with the rest. See `docs/adr/ADR-002`.
  Re-measure with `python scripts/api-reachability.py`.
- `service/` is 8,224 lines in one flat package defined as "everything that isn'''t a run".
