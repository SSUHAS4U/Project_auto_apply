# JobPilot docs

Everything that is not code. Four kinds of document, and the difference matters — they get out
of date in different ways and are repaired differently.

## The map — read this first

| Document | What it is | When it changes |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | A file-by-file map: what owns what, the invariants a rewrite must keep, the failure modes that have actually happened. | In the same commit as any change that makes it wrong. |
| [AUTOMATION.md](AUTOMATION.md) | The incident log — *why* things are the way they are. Gitignored, so it is local to the owner's machine. | Every worker/agent change, and every outage worth not repeating. |

`ARCHITECTURE.md` says *what things are*. `AUTOMATION.md` says *why*. Neither replaces the other.

## Decisions

| Document | Decision |
|---|---|
| [adr/ADR-001-repository-structure.md](adr/ADR-001-repository-structure.md) | Where the real structural debt is, and what was done about the repository layout. |

An ADR is a record, not a plan. Superseded ADRs are marked, never deleted — a decision that was
reversed is still evidence of what was known at the time.

## Specs

`superpowers/specs/` holds design documents written before implementation, dated. They describe
intent at a point in time and are **not** maintained afterwards; `ARCHITECTURE.md` absorbs
whatever of them is still true.

| Spec | Covers |
|---|---|
| [superpowers/specs/2026-09-19-jobs-module-design.md](superpowers/specs/2026-09-19-jobs-module-design.md) | One job card on every job surface; Daily picks, Scout and the ingest CI. |

## Guides

| Document | Audience |
|---|---|
| [SETUP.md](SETUP.md) | Getting the stack running from scratch. |
| [APP_GUIDE.md](APP_GUIDE.md) | Every screen, walked through. |
| [API.md](API.md) | The REST surface. |
| [EXTENSION.md](EXTENSION.md) | Loading and using the Chrome extension. |
| [UI_SPEC.md](UI_SPEC.md) | The agreed look, the tokens, and the reference notes behind them. Read before any UI change. |
| [RUN_CHECKLIST.md](RUN_CHECKLIST.md) | What to check before and after a run. |
| [JobPilot-Build-Spec.md](JobPilot-Build-Spec.md) | The original build specification. Historical. |

## What is deliberately NOT here

- **`README.md`** stays at the repository root — GitHub renders the root one as the project
  homepage, and a repo whose front page is blank is a worse outcome than an untidy root.
- **`CLAUDE.md`** stays at the repository root — the coding agent loads project instructions from
  that exact path. Moving it silently disables every rule it contains, with no error.
- **`SECURITY.md`** moved to `.github/`, which GitHub still recognises for its security policy
  link, so nothing was lost by taking it off the root.
