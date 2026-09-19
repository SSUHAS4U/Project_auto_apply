# ADR-002: Backend boundaries — the dead HTTP surface and the `service` junk drawer

**Status:** Proposed
**Date:** 2026-09-19
**Deciders:** repo owner
**Supersedes nothing.** Extends [ADR-001](ADR-001-repository-structure.md), which settled the
repository *layout*. This one is about the structure *inside* `backend/`, which is where the
debt actually is.

---

## Context

ADR-001 concluded that the top-level directory shape was already correct and that the real
structural problems were internal. This ADR measures them.

Everything below is counted, not estimated. The endpoint reachability figures come from a
script that parses every `@*Mapping` in the backend and cross-references it against every
string literal beginning `/api/` in the frontend, extension, worker, desktop app, workflows
and scripts.

### Finding 1 — Roughly a third of the HTTP surface has no caller

**173 endpoints mapped. 120 called. 53 with no caller anywhere in the repository.**

| Controller | Uncalled / total | Note |
|---|---|---|
| `EngineController` | **19 / 24** | Only `status`, `profile`, `prefill`, `guided` are used — the setup screen. Apply, rank, scrape, interview, upskill, autopilot and PDF generation have no client. |
| `PilotController` | **12 / 12** | The entire HTTP surface. **But see the correction below — the package is not dead.** |
| `AgentController` | 11 / 29 | `contacts`, `frame`, `messages`, `metrics`, `runs`, `schedule` and others. |
| `OpsController` | 5 / 17 | Several are legitimately machine-only (`/api/sources`, maintenance). |
| Others | 6 | Includes false positives — `/health` is called by the deploy check over plain HTTP, and `/api/ingest-diag/runs` is diagnostic by design. |

**The correction matters more than the headline.** `PilotController` exposes twelve endpoints
that nothing calls, and the obvious conclusion — delete the `pilot` package — is **wrong**.
`ExtensionController` holds a `PilotOrchestrator` and the Chrome extension drives it through
`/api/extension/auto-apply/queue`. The *controller* is dead; the *service* is load-bearing.

That is the single most important thing in this document: **"no endpoint is called" and "this
code is dead" are different claims**, and this codebase contains a case where believing the
first would have deleted a working feature. Every removal below is justified against usage of
the *class*, never the route.

### Finding 2 — `service` is not a boundary, it is a bag

**8,224 lines across 35 files in one flat package**, defined in `ARCHITECTURE.md` as
"everything that isn't a run". That is not a description of a responsibility.

What is actually in there: authentication, profiles, résumé storage and parsing, PDF rendering,
mail (two transports), job ingest, scoring, scouting, daily curation, digests, notifications,
admin, secrets, settings, cleanup, background running, and name parsing.

A name that cannot be wrong cannot guide anything. New code lands in `service` because `service`
accepts everything, and the package grows monotonically.

### Finding 3 — Files that no longer fit in one head

| File | Lines |
|---|---|
| `agent/AgentService.java` | 1,611 |
| `service/AssistService.java` | 1,456 |
| `pilot/PilotOrchestrator.java` | 712 |
| `engine/EngineApplyService.java` | 664 |
| `frontend/src/components/AutomationPanels.tsx` | 965 |
| `frontend/src/pages/ProfilePage.tsx` | 837 |
| `frontend/src/styles.css` | 2,185 |

### Finding 4 — WITHDRAWN. The render suite *is* in CI.

An earlier draft of this ADR claimed `ci.yml` never runs the Playwright suite, on the strength
of a line in `ARCHITECTURE.md` §7 saying "No automated render verification in CI".

**That line is stale and the claim was false.** `ci.yml` runs `npm test`, which is
`node --test "test/**/*.test.mjs"` and therefore includes `responsive.test.mjs`. It even
asserts `google-chrome --version` first, precisely so a missing browser cannot skip the suite
and look like a pass. Verified against run 35434894152: 74/74 on the runner, including the
render checks across 16 routes.

Recorded rather than quietly deleted, because the interesting part is the mechanism: the ADR
inherited a wrong fact from a stale document and nearly turned it into work. `ARCHITECTURE.md`
is corrected in the same commit as this ADR.

**The real gap is narrower:** nothing enforces that the suite *stays* wired in. A future edit
to `package.json`'s `test` script could drop it silently.

### Finding 5 — Config had no validation at all until today

A duplicate `jooble:` key in `application.yml` took the backend down for ~30 minutes on
2026-09-19. Nothing read that file outside a running application, so a syntax-level defect
could only be discovered by deploying it. `ApplicationYamlTest` now closes this, but the
general shape — *config is code and had no tests* — is worth naming.

---

## Decision

**Remove the dead HTTP surface. Split `service` along the seams it already has. Lock the render
suite in so it cannot be unwired. One shippable commit each.**

Do **not** delete the `pilot` or `engine` packages wholesale. Both contain live code behind dead
routes, and the distinction is only visible per-class.

---

## Options Considered

### Option A — Delete the dead routes only, leave the packages (recommended)

Remove the 31 endpoints that have no caller *and* whose handler bodies are not reachable from a
live path. Keep every service class that anything still constructs.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — deletions, no moves |
| Risk | **Low**, and independently checkable: the reachability script re-runs and must show 0 uncalled |
| Payoff | Removes ~30% of the API surface, and with it the security surface |

**Pros:** every deleted line is provably unreachable; shrinks the authenticated attack surface;
makes the next person's reachability question answerable.
**Cons:** leaves the packages themselves oddly shaped — an `engine` with no engine endpoints.

### Option B — Delete the routes AND fold the orphaned services into their real owners

As A, then move `PilotOrchestrator` under the extension's owner and `EngineProfileRepository`
under `agent`, deleting what is then unreferenced.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Risk | Medium — touches live code paths the extension depends on |
| Payoff | Two packages disappear entirely |

**Pros:** ends with a backend whose package names all mean something.
**Cons:** the extension's auto-apply queue is a live feature with no automated test; moving its
service is a real regression risk for a cosmetic gain.

### Option C — Full rewrite into hexagonal/ports-and-adapters layering

**Rejected.** This is a single-operator application with 204 backend tests and no test for the
extension queue. A layering rewrite would rebuild boundaries the code does not yet need while
putting every working feature at risk simultaneously. The problems measured above are
concentrated and can each be fixed in isolation; nothing here calls for restructuring the parts
that work.

---

## Trade-off Analysis

The tempting move is B, because it ends with a tidy package list. But the thing that made this
codebase hard to reason about is not the package names — it is that **31% of the HTTP surface
does nothing and nobody could tell which 31%**. Option A fixes exactly that, and it is verifiable
by a script that either reports zero or does not.

Option B's remaining benefit is aesthetic and its risk lands on the one live feature with no
test coverage. It should follow A, if at all, and only after the extension queue has a test.

The `service` split is separable from both and carries near-zero risk: moving a class between
packages in Java is a compiler-checked operation.

---

## Consequences

**Easier:** answering "is this called?"; auditing the authenticated surface; finding where a
responsibility lives once `service` is split.

**Harder:** nothing immediately. Longer term, deleted endpoints that someone wanted to revive
must come back from git history — which is the correct cost, since an endpoint kept "just in
case" is an endpoint nobody tests and everybody must still secure.

**To revisit:** Option B, once the extension's auto-apply queue has a test worth trusting.

---

## Action Items

1. [x] ~~Wire `responsive.test.mjs` into CI~~ — **already wired**; see withdrawn Finding 4.
2. [ ] **Delete the 19 uncalled `EngineController` endpoints** and any service method left with
       no caller afterwards. Keep `status`/`profile`/`prefill`/`guided`.
3. [ ] **Delete `PilotController` entirely** (12/12 uncalled). **Keep `PilotOrchestrator`** — the
       extension drives it via `ExtensionController`.
4. [ ] **Delete the 11 uncalled `AgentController` endpoints**, checking each against the worker,
       which is a client the frontend grep does not cover.
5. [ ] **Re-run the reachability script; require 0 uncalled** (allow-listing `/health` and
       `/api/ingest-diag/*` explicitly, with a reason).
6. [ ] **Split `service`** into `auth/`, `profile/`, `documents/`, `mail/`, `jobs/`, `ops/`.
       Compiler-checked; no behaviour change.
7. [ ] **Split `AgentService` (1,611)** along scheduling / runs / outreach.
8. [ ] **Frontend:** design tokens and one breakpoint scale, then `AutomationPanels.tsx` into one
       file per panel.

Items 1–5 are the architecture work. 6–8 are the follow-through.
