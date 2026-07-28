# JobPilot — project rules

## Testing (non-negotiable)

**Thoroughly test every UI change — and anything else that can be tested — in every aspect
before shipping it. Not just the happy path.**

For any UI change, verify with a real render (Playwright screenshot + measured geometry), and
explicitly check the edge cases, because that is where things break:

- **First and last elements** — e.g. a tooltip/popover on the leftmost AND rightmost data
  point (does it overflow the container? does it force a scrollbar?), the first/last row, etc.
- **Overflow & scroll** — confirm the change does not introduce an unexpected scrollbar; the
  page body must never scroll horizontally.
- **Empty / zero / single-item state** — no data, one bucket, all-zero values.
- **Min & max values** — longest label, biggest number, smallest.
- **Both light and dark themes.**
- **Responsive widths** where relevant (narrow screens, wrapping).

Do the whole task in one pass and verify each part, rather than shipping a piece and finding
the edge case broken on the next round. If something genuinely cannot be tested here (e.g. a
live third-party page like LinkedIn or Microsoft Forms), say so explicitly and test the closest
faithful mock instead.

## Shipping

- The **web dashboard** deploys from `master` (Vercel) on push.
- The **desktop app** bundles its own copy of the built dashboard + the worker, so frontend and
  worker changes only reach desktop users after a new `desktop-v*` tag builds an installer.
  A web refresh cannot update the desktop app.
- The **backend** deploys on push to `master` (GHCR image → VM rollout).
- The **Chrome extension** ships in the frontend build's zip; bump `extension/manifest.json`
  version and tell the user to reload it.
