# ADR-003: Boundaries for the `service` package

**Status:** Accepted — implemented 2026-09-19
**Date:** 2026-09-19
**Deciders:** repo owner
**Closes** [ADR-002](ADR-002-backend-boundaries.md) action item 7.

---

## Context

`com.jobpilot.service` held **36 classes and 8,224 lines in one flat package**, described in
`ARCHITECTURE.md` as *"everything that isn't a run"*.

That is not a responsibility, it is a residue. A name that cannot be wrong cannot guide
anything, so new code landed there by default and the package only ever grew. What was actually
inside: authentication, profiles, résumé storage and parsing, PDF rendering, two mail
transports, job ingest, scoring, scouting, daily curation, digests, notifications, admin,
secrets, settings, cleanup, background running and name parsing.

### The boundaries were derived, not invented

Rather than grouping by what the names suggested, the split follows **actual constructor
injection** — a class's real collaborators, extracted from its `private final` fields:

```
BackgroundRunner    -> DailyService, IngestProgress, IngestService, NotificationService
DailyService        -> CleanupService, DigestService, IngestService, JobService,
                       NotificationService, ProfileService, SettingsService
IngestService       -> CleanupService, IngestProgress, MatchScorer, NormalizeService
JobScoutService     -> MatchScorer, NormalizeService
SavedJobService     -> ApplicationService, MatchScorer, NormalizeService
ComposeService      -> MailService, ProfileService, SettingsService
DigestService       -> MailService, NotificationService, SettingsService
EmailApplyService   -> ApplicationService, MailService, ProfileService
MailService         -> BrevoMailClient
ResumeAnalysisService -> ProfileService, ResumeTextExtractor
```

Two clusters fall out immediately — everything touching `MatchScorer`/`NormalizeService` is job
pipeline, everything touching `MailService` is mail — and `ProfileService` and `SettingsService`
show up as cross-cutting (7 and 4 internal dependents), which is why neither became a parent of
anything.

---

## Decision

Eight packages under `com.jobpilot.service`, sized by what they own rather than evenly:

| Package | Files | Lines | Owns |
|---|---|---|---|
| `jobs/` | 13 | 2,582 | Ingest, normalise, score, scout, clean, daily curation, saved + tracked applications |
| `assist/` | 2 | 1,720 | The extension's question-answering brain and the chat assistant |
| `documents/` | 6 | 1,017 | Résumé storage, parsing, analysis, PDF rendering, the document vault |
| `ai/` | 5 | 974 | *(existing)* The only package allowed to touch a provider client |
| `mail/` | 6 | 905 | SMTP + Brevo transports, compose, digest, email-apply |
| `ops/` | 6 | 636 | Auth, admin, secrets, settings, notifications, background runner |
| `profile/` | 2 | 212 | The profile and its derived name parts |
| `cover/` | 4 | 200 | *(existing)* Cover-letter generation |

`NotFoundException` stays at `service/` root as the shared kernel — it is referenced by nine
classes across every new package and by three outside `service`, so pushing it into any one of
them would invert the dependency.

---

## Options Considered

### Option A — Split by domain, following injection (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — 35 file moves, ~60 files' imports |
| Risk | **Low** — every reference is compiler-checked |
| Payoff | The largest package drops from 8,224 to 2,582 lines |

**Pros:** boundaries match how the code already collaborates, so they are stable; each package
name makes a wrong home for a new class *visible*.
**Cons:** `jobs/` is still the biggest thing in the backend, and `assist/` is one 1,457-line
class in a trench coat.

### Option B — Split by technical layer (`services/`, `clients/`, `util/`)

**Rejected.** It groups a mail client with an AI client because both are "clients", which is
exactly the kind of boundary that tells you nothing when you are looking for where sending an
email lives. Layer-shaped packages also guarantee that every feature change touches every
package.

### Option C — Leave it flat, rely on file names

**Rejected**, but it is the honest baseline: the package had survived this long. It was rejected
because the failure is cumulative rather than acute — nothing breaks, it just gets slower to
find anything, and the package had already reached 36 classes with no force acting against it.

---

## Trade-off Analysis

The risk here is almost entirely *mechanical*, and Java's compiler removes it: a missed reference
does not build. The genuine risks were the two things that are **not** compiler-checked, and both
were verified explicitly before committing:

1. **Spring component scanning.** `@SpringBootApplication` sits on `com.jobpilot` with no
   `basePackages` override anywhere in the codebase, so new subpackages are scanned
   automatically. Checked before moving anything.
2. **`AiRoutingGuardTest`, which reads the source tree.** It walks
   `src/main/java/com/jobpilot` and excludes `service/ai` — path-based, so a reorganisation
   could have silently widened or broken it. It still passes, and still enforces the invariant.

Against that, the payoff is real but bounded: this makes the code easier to navigate. It does
not make the product more correct, more secure, or faster. It was worth doing because the
package had no force limiting its growth, not because it was causing incidents.

---

## Consequences

**Easier:** finding where a responsibility lives; seeing when a class is in the wrong place,
because a wrong home is now visibly wrong; reviewing a change, since the touched packages
describe the change.

**Harder:** a genuinely cross-cutting service now needs a deliberate home rather than defaulting
into the bag. That is the point, but it is friction.

**Caught in passing:** two tests (`ScoutOriginTest`, `QuestionShapeTest`) relied on
package-private access to classes they exercise, so they moved with them. Worth noting because
it is a signal, not a nuisance: a test that must share a package is testing an internal, and
moving them keeps that relationship visible.

**To revisit:** `assist/` is 1,720 lines across two files. Splitting `AssistService` (1,457) is
ADR-002 item 8 and remains open.

---

## Action Items

1. [x] Derive boundaries from constructor injection rather than from names.
2. [x] Verify component scanning needs no change.
3. [x] Verify `AiRoutingGuardTest` survives the move.
4. [x] Move 35 classes into 6 new packages; keep `ai/` and `cover/` as they were.
5. [x] Move the two package-private tests alongside the classes they exercise.
6. [x] 204 backend tests green; API reachability unchanged at 141/124/17.
7. [ ] Split `AssistService` (1,457 lines) — ADR-002 item 8.
8. [ ] Split `AgentService` (1,611 lines) — ADR-002 item 8.
