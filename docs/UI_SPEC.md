# JobPilot — UI spec

The agreed look, and where it came from. Read this before any UI change; it exists so the same
decisions are not re-derived every session.

---

## Product references

Agreed 2026-09-14. **Linear** is the anchor.

| Reference | Captured | Why this one |
|---|---|---|
| **Linear — Method** | `~/.claude/design-library/notes/linear.md` | JobPilot is a dense internal tool with long settings surfaces and a lot of numbers. Linear is the reference for restraint in exactly that shape. |

Groww and Wise are in the design library and remain available for specific patterns (data density,
captioned figures) but are not the anchor.

---

## REFERENCE NOTES

What was taken from the reference, as decisions rather than colours.

```
Source           Decision replicated
Linear/Method    Emphasis comes from WEIGHT and SIZE, never from colour.
Linear/Method    A three-step text ladder and nothing more:
                   heading (--text) · body (--text-dim) · meta (--text-faint)
Linear/Method    ONE saturated element per surface. Everything else greyscale.
Linear/Method    A border appears only where two different KINDS of thing meet —
                 not around every item.
Linear/Method    Background near-black, not black, so elevated surfaces can lift
                 off it. (--bg #0a0b0f already satisfies this.)
Linear/Method    Vertical rhythm is large and consistent; the gap size itself
                 signals the hierarchy level.
Groww #10        The accent is brand/CTA only — NEVER a data colour.
Groww #13        A hero number is large, semibold, in the UI face — not mono.
```

### What this rules out, specifically

The dashboard had **eight hardcoded hex colours**, one per metric tile
(`#5b5bd6 #2563eb #d97706 #16a34a #7c3aed #0891b2 #db2777 #16a34a`), tinting an icon in each card,
plus six pill tones across sixteen pills on one screen. None of it carried meaning: a metric is not
"more purple" than another. That is colour as decoration, and it is the clearest generated-UI tell
on the page. Under this spec colour is only ever semantic.

---

## Tokens

The token layer already exists in `frontend/src/styles.css` under `:root` and
`:root[data-theme="light"]`. Rules that follow from having it:

- **No raw hex in a component.** If a colour is needed that no token covers, the token set is wrong.
- **Semantic names.** `--danger`, not `--red`, at the point of use.
- Light and dark are designed together and contrast-checked separately.

### Colour budget per surface

| Role | Token | Used for |
|---|---|---|
| Accent | `--accent` / `--accent-hi` | The one primary action, and the active nav state. Nothing else. |
| Success | `--green` | A good terminal outcome only: applied, reply received. |
| Danger | `--red` | A real problem only. |
| Everything else | `--text` / `--text-dim` / `--text-faint` | All other state, all chrome, all icons. |

Warning (`--amber`) is reserved for a state the user must act on. It is not a category colour.

### Numbers

- `font-variant-numeric: tabular-nums` on anything that updates or aligns.
- Thousands separated (`360,780`, never `360780`).
- Unknown renders `—`, never `0`. A zero is a claim.

---

## Density

`comfortable` on settings and profile surfaces; `compact` on tables and the job board. Decided per
surface, not per component.

---

## Verification

`frontend/test/responsive.test.mjs` renders every route at 360/768/1280 in both themes against
empty AND populated fixtures, and fails on horizontal page scroll or any element escaping the
viewport. A UI change is not done until that suite passes and the screenshots have been looked at.

---

## REFERENCE NOTES — one job card on every job surface

Added 2026-09-19. Source: `~/.claude/design-library/notes/linear.md` (already captured — not
re-browsed, per the library rule) plus this repo's own `JobCardV2`.

**This task was component REUSE, not component design.** The highest-preference option in the
reuse order — "a component this project already has" — applied directly: `JobCardV2` was already
serving the board, Daily picks, Scout and the portal panels, and the request was to extend it to
Saved jobs and the tracker. No registry was searched and no alternative card was offered, because
offering alternatives would have meant re-opening a decision the owner had already made by
pointing at the board and saying "like that".

```
Source            Decision replicated
Linear/Method     Absence is shown by absence. A fact the posting never carried is OMITTED,
                  not printed as "Not mentioned" — the same reason Linear puts a border only
                  where two KINDS of thing meet rather than around every block. Four
                  "Not mentioned" cells is a card apologising for itself.
Linear/Method     Emphasis from weight and size, never colour. The tracker card's status
                  control is the one interactive element; the match score stays data-coloured.
Linear/Method     Vertical rhythm signals hierarchy — the card's existing 24px card padding
                  and 12px inter-card gap are kept, not re-derived per surface.
JobCardV2         The card already degrades when `score` is absent (no fit panel). `sparse`
                  extends that same principle to the fact row instead of adding a second
                  card shape.
UI_SPEC Groww#10  The accent is CTA only. "Promote to tracker" is the one accent-filled
                  button on a saved card; everything else is ghost.
```

### What this rules out

A second card component for "saved" or "tracked" listings. There is one card; a surface that
cannot fill it either gets its data fixed at the source (which is what the extension capture and
the `JobSummary` DTO change do) or passes `sparse`. A fork would drift within a release — that is
exactly how the tracker ended up with a desktop table and a *separate* mobile card that had
already diverged in what it showed.
