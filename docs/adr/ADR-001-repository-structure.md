# ADR-001: Repository structure and where the real structural debt is

**Status:** Proposed
**Date:** 2026-09-19
**Deciders:** repo owner

---

## Context

The request: reorganise the repository into nested product folders — a `job/` folder holding
frontend and backend, an `automation/` folder, an `extension/` folder — to make the
architecture "production level".

The current top level is one folder per **deployable unit**:

```
backend/    Spring Boot 21      → GHCR image → GCP VM
frontend/   React + Vite        → Vercel, and bundled into desktop
worker/     Node + playwright   → inside the desktop app
extension/  MV3                 → zipped into the frontend build
desktop/    Electron            → desktop-v* tag → installers
```

Two facts shape this decision.

**First: that layout is already the conventional one.** "One directory per independently
deployable artifact, at the top level" is what Nx, Turborepo, Bazel and every polyglot
monorepo converge on. The proposed `job/{frontend,backend}` adds a nesting level that groups
two things which deploy separately, on different triggers, to different providers — while
`worker/` and `extension/` do not deploy independently at all and would keep top-level
folders. The nesting would not reflect a real boundary.

**Second: moving these folders is not a cheap operation.** The paths are load-bearing in
places a `git mv` does not reach:

| Coupling | Where |
|---|---|
| `context: ./backend`, `working-directory: backend\|frontend\|worker\|desktop` | 6 workflow files |
| `cd ../frontend`, `cd ../worker`, `from: ../frontend/dist`, `from: ../worker` | `desktop/package.json` (electron-builder `extraResources`) |
| `../frontend/dist` | `desktop/main.js` |
| `../extension` | `frontend/scripts/pack-extension.mjs` |
| **Project root directory** | **Vercel dashboard — configured outside the repo** |

That last row is the dangerous one. The web deploy's root path lives in Vercel's UI, not in a
file. A folder move breaks production web deploys in a way no commit records and no test
catches, and the fix is in a dashboard.

### Where the structural debt actually is

Measured, not asserted:

| Finding | Evidence |
|---|---|
| **The `engine/` subsystem is 83% unreachable** | `EngineController` exposes **24 endpoints**; the frontend calls **4** (`status`, `profile`, `prefill`, `guided`). Apply, rank, scrape, interview, upskill, autopilot and PDF generation have no caller, and the cron that drove them is disabled (`auto-apply-cron:-`). ~2.8k lines kept alive by a setup screen. |
| **No design-token layer** | One 2,185-line `styles.css` with 37 media queries across **14 ad-hoc breakpoints** (480…1180). Nothing defines what the device classes are, so each component was made responsive at whatever width its author tested. Already `ARCHITECTURE.md` §7. |
| **God files** | `AgentService` 1611, `AssistService` 1456, `AutomationPanels.tsx` 965, `ProfilePage.tsx` 837, `PilotOrchestrator` 712. |
| **`service/` is a junk drawer** | 7.9k lines defined as "everything that isn't a run" — a name that describes no boundary. |
| **Dead config presented as working** | `JOBPILOT_JOOBLE_KEY` read by nothing (no connector exists); Adzuna and Google CSE keys with no connectors; `daily_pick` written daily and read by nothing. |
| **No render verification in CI** | The Playwright suite exists and is not wired into `ci.yml`. |

None of these are fixed by moving a folder. All of them are what "production level" actually
refers to.

---

## Decision

**Keep the top-level layout. Do the restructuring inside the modules, worst-first, in
separately shippable passes.**

Rename `worker/` → `automation/` only if the owner wants the vocabulary to match the product;
it is a one-module move touching 3 files and is the one rename that carries meaning.

---

## Options Considered

### Option A — Nest into product folders (`job/{frontend,backend}`, `automation/`, `extension/`)

| Dimension | Assessment |
|-----------|------------|
| Complexity | High — 6 workflows, electron-builder, 2 scripts, plus an out-of-repo Vercel setting |
| Cost | Days, most of it re-verifying deploys that cannot be tested before merge |
| Scalability | Neutral — helps only if a second product appears |
| Risk | **High** — silently breaks web deploy via a dashboard setting no commit can fix |

**Pros:** matches the mental model of "the job app" as one thing; shorter top level.
**Cons:** groups two units that deploy separately; splits nothing that is currently tangled;
every line changed is a path, not a boundary; the diff is enormous and unreviewable, which
would bury the feature work landing in the same period.

### Option B — Keep the layout, restructure inside the modules (recommended)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium, and **incremental** — each pass ships on its own |
| Cost | Spread across passes; each one independently valuable |
| Scalability | High — removes the things that actually make change slow |
| Risk | Low — no deploy path moves; existing tests keep applying |

**Pros:** attacks the measured debt; every pass is reviewable and shippable; no deploy risk.
**Cons:** the top level looks the same afterwards, so the progress is less visible.

### Option C — Both: restructure inside, then move folders later

**Pros:** ends at Option A with the debt already paid.
**Cons:** pays Option A's full risk for its unchanged benefit. Worth revisiting only if a
second product is ever added to this repo.

---

## Trade-off Analysis

The request treats directory shape as a proxy for architectural quality. Usually it is, because
a tangled codebase and a messy top level travel together. **Here they have come apart:** the top
level is already correct and the mess is *inside* `backend/service/`, inside `styles.css`,
inside `AgentService.java`, and in a half-dead `engine/` package.

Option A moves every path in the build and leaves all six findings in place. Option B leaves
every path alone and removes them. The visible-progress argument favours A; every engineering
argument favours B.

The one part of the request worth taking literally is the vocabulary: `worker/` is what the
product calls **automation** everywhere else, including `AUTOMATION.md`. That rename is cheap
and makes the tree self-describing.

---

## Consequences

**Easier:** finding where a decision lives; changing the UI without re-deriving breakpoints;
deleting the engine's dead surface without fear; onboarding, because `ARCHITECTURE.md` stops
describing a subsystem that mostly does not run.

**Harder:** nothing in the build changes, so the improvement is not visible from the repo root.
That is the real cost of Option B and should be accepted deliberately.

**To revisit:** if a second product lands in this repo, Option A becomes correct and should be
done then — with the Vercel root change planned as part of it.

---

## Action Items

Ordered worst-first. Each is independently shippable.

1. [ ] **Settle the engine.** Decide whether the 20 uncalled endpoints come back or come out.
       If out: delete the dead services and keep the 4 setup endpoints the UI uses.
       *Biggest single reduction available (~2.8k lines) and unblocks reasoning about the rest.*
2. [ ] **Design tokens + one breakpoint scale** in `frontend/`, then move components onto it.
       Replaces 14 ad-hoc breakpoints. Already required by `docs/UI_SPEC.md`.
3. [ ] **Wire the Playwright suite into `ci.yml`.** It exists and nothing runs it, so UI
       regressions are still caught by eye.
4. [ ] **Split the god files** along the seams they already have —
       `AgentService` (scheduling / runs / outreach), `AutomationPanels.tsx` (one panel per file).
5. [ ] **Name the `service/` boundary,** or split it into `profile/`, `documents/`, `ai/`, `mail/`.
6. [ ] **Delete dead config** and the code that pretends to read it.
7. [ ] `worker/` → `automation/` — the one rename that carries meaning. 3 files.
8. [ ] Fold this ADR's conclusions into `ARCHITECTURE.md` §7.

---

## Note on sequencing

The Jobs-module work specced in `2026-09-19-jobs-module-design.md` is **in flight and
uncommitted** as this ADR is written. Interleaving a structural pass with it would produce a
diff where moved files and changed behaviour are indistinguishable — the single most expensive
kind of review. The Jobs work lands and ships first; structural passes start from a clean tree.
