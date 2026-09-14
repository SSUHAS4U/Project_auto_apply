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
