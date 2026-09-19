# Jobs module — one card, one home, three working feeds

Design agreed 2026-09-19. Covers the Jobs module end to end: how a job is *shown* (one card
everywhere), where the job surfaces *live* (nav), and why two of the three feeds behind them
were not doing what their UI claimed.

Read `ARCHITECTURE.md` for the map and `docs/UI_SPEC.md` for the look. This file is the
decision record for one change; when it is implemented, those two absorb what is still true
and this file stops being authoritative.

---

## 1. What was actually wrong

Everything below was verified against the live system or CI on 2026-09-19. Nothing here is
inferred from reading code alone.

### 1.1 The scheduled workflows have never worked since the Render → GCP move

`gh run view` on the latest `ingest` failure:

```
env:
  BACKEND_URL:          ← empty
  API_TOKEN:            ← empty
curl: (3) URL rejected: No host part in the URL
```

`gh secret list` held only `RENDER_*`, `VERCEL_*` and `VM_*`. **`BACKEND_URL` and `API_TOKEN`
were never created after the backend moved off Render.** `ingest`, `daily` and `digest` have
therefore failed on every scheduled run for months.

`keep-alive` is worse than broken — it is **falsely green**. Its curl ends in
`|| echo "000"`, so a total failure still exits 0. It has been reporting success while
logging `ping #1 -> HTTP 000000`. It is also obsolete: it existed because Render's free tier
slept after 15 minutes, and the backend now runs on a GCP VM that does not sleep.

**The board itself was never affected.** The in-app scheduler is the primary trigger and it
works: `application.yml` sets `ingest-cron` to 07:00/14:00/20:00 IST and `scout-cron` hourly,
and `/api/sources` on the live backend returns 86 active ATS boards, every one health-checked
at 01:00 that morning, 16,337 listings at last check. The red CI was redundancy, not the
pipeline.

### 1.2 Daily picks throws away the curation it pays for

`DailyService.run()` ranks jobs, calls the AI for a briefing, and writes the `daily_pick`
table. `DailyPickRepository.findAllByOrderByRankAsc()` **is never called anywhere in the
backend.**

`/api/daily/picks` — the endpoint the page actually reads — ignores the table and re-runs
`jobService.search(score≥40, 14 days, size 12)`. So "AI-curated daily picks" is the job board
with a different filter, and the AI ranking is computed daily and discarded.

### 1.3 Scout advertises four sources and has one

The page copy promises "across LinkedIn, Naukri, Indeed & the web".

| Channel | Reality |
|---|---|
| **LinkedIn** | Works. Guest endpoint verified live: HTTP 200, 10 cards, existing regexes still match. |
| **Jooble** | `JobScoutService` looks for a connector named `jooble`. **No `JoobleConnector.java` exists.** The branch is unreachable; `JOBPILOT_JOOBLE_KEY` in prod is read by nothing. |
| **Careerjet** | `isConfigured()` requires `affid`. No `JOBPILOT_CAREERJET_*` key exists in prod. Silently skipped. |
| **Google** | In the UI's source dropdown. No connector exists; the CSE keys in prod are empty. |

Net: Scout is LinkedIn-only, two keywords per hourly run out of a list of eight.

**Jooble does not solve Naukri/Indeed.** The key was tested live — HTTP 200, 23 jobs, full
record shape. But every `link` is a `jooble.org/jdp/…` redirect, and the `source` field shows
the real origins are niche boards (`decentrajobs.com`, `jobs.dish.com`, `careers-inc.nttdata.com`,
`ceipal.com`, `exelare.com`). The existing code comment claiming Jooble "aggregates
Naukri/Indeed/LinkedIn postings and deep-links to the originals" is false. Jooble adds real
volume and carries a usable origin label; it does not make the Naukri/Indeed claim true.
Only Careerjet might, and that needs a publisher `affid` the owner does not yet have.

### 1.4 The shared card is starved of data, not missing

`JobCardV2` is already the one card, used by the board, Daily picks, Scout and the portal
panels. The reason Saved jobs and the tracker don't use it is that neither carries the data
it needs:

- `ApplicationView.JobSummary` projects 8 fields and **drops `description`, `source`,
  `salaryText` and `postedAt`** — even though the linked `Job` row has all four.
- `SavedJob` has no description at all: `scanListing()` in the extension hard-codes
  `raw: null`, despite already having `extractJobText()` in hand.

A naive drop-in of `JobCardV2` would therefore render four "Not mentioned" cells and no fit
panel. The fix is to feed the card, not to fork it.

---

## 2. What we are building

### 2.1 Nav — Applications moves under Jobs

`NAV` in `components/Layout.tsx` is the single source for both the sidebar and the dock, so
this is one array edit and nothing else.

```
Jobs ─┬─ Job board      /jobs
      ├─ Daily picks    /daily
      ├─ Scout          /scout
      ├─ Applications   /applications   ← moved from top level
      └─ Saved jobs     /saved          ← the dissolved group's other child
```

The top-level **Applications** entry is removed. Routes are untouched, so every existing
link and bookmark keeps working.

> The owner named only Applications. Saved jobs was the other child of the group being
> dissolved and is itself a list of jobs, so it moves with it. This is the one inferred
> decision in the design and is called out for that reason.

### 2.2 One card on every job surface

`JobCardV2` stays the only card. Two changes make it usable everywhere:

**Graceful degradation.** A fact cell renders "Not mentioned" today. That is right for a board
listing (a thin listing should read as thin) and wrong for a saved job, where the data was
never collected rather than never stated. The card gains one optional prop —
`sparse?: boolean`, default `false`, so every existing caller is unchanged — under which an
absent fact is omitted instead of printed, and the meta row disappears entirely if no fact
survives. The fit panel already renders only when `score` is a number, which is the correct
behaviour and stays as is. Saved jobs pass `sparse`; no other surface does.

**Feed it real data:**

| Surface | Change |
|---|---|
| Applications | Add `description`, `source`, `salaryText`, `postedAt` to `ApplicationView.JobSummary`. The tracker then gets real fit panels, skill tags and facts from data that already exists in the row. |
| Saved jobs | Extension captures the description on save; backend stores it and scores the saved job with the same `MatchScorer` the board uses. |

**Applications keeps its table.** Cards become the default at every width, with the same
`▦ / ≣` toggle the Jobs board already has. A tracker is the one surface where scanning status
and dates down a column beats reading cards, so removing the table would cost something real.
The mobile-only card block is deleted — the shared card replaces it at all widths.

**Saved jobs** loses its bespoke card entirely, including the inline-styled grid. Its edit
mode, promote/open/delete actions and the extension guide are preserved as card actions.

### 2.3 Daily picks serves its own curation

`/api/daily/picks` reads the `daily_pick` rows in rank order and returns them with the
briefing generated in the same run.

`daily_pick` gains a `user_id`, so curation is user-scoped like every other surface in the
app. The daily run curates for each user holding a profile with skills.

**Fallback, explicitly labelled.** When a user has no picks yet — fresh install, or the run
has not happened — the page falls back to the live board query and *says so*. A blank page
and a page silently pretending to be curated are both worse than an honest one.

### 2.4 Scout tells the truth and gains a second real channel

- **Build `JoobleConnector`** implementing `JobConnector`: `source()` = `"jooble"`,
  `isPerBoard()` = false, configured when the key is present. Parses the verified shape
  (`{ totalCount, jobs[] }` with `title/company/location/snippet/salary/source/link/updated`),
  decoding the HTML entities and `<b>` tags Jooble embeds in `snippet`.
- **Origin over host.** `hostSite()` maps by URL host, which labels every Jooble result
  "jooble". Scout will prefer the connector-supplied origin (Jooble's `source` field) so a
  listing shows where it actually came from.
- **Careerjet reports itself.** Instead of being silently skipped, it appears in the channels
  report as *"not configured — set `JOBPILOT_CAREERJET_AFFID`"*. It needs no code to switch
  on once the owner registers.
- **Honest UI.** The source filter is built from the channels that exist, and the page copy
  names them. Google is removed from the dropdown until a connector exists.
- **Wider rotation.** Two of eight keywords per run means full coverage takes four hours.
  This becomes `jobpilot.scout.linkedin-keywords-per-run`, default **4** — full coverage in
  two hourly runs, at four guest requests per hour, which stays polite. The rotation still
  advances by hour so the set differs run to run rather than re-fetching the same head.
- **HTTP leaves the transaction.** `JobScoutService.run()` and `DailyService.run()` are both
  `@Transactional` wrapped around minutes of outbound HTTP, holding a DB connection for the
  duration. Fetch first, persist second.

### 2.5 CI

- `BACKEND_URL` and `API_TOKEN` secrets — **done 2026-09-19**, verified by dispatch.
- **Delete `keep-alive.yml`.** Obsolete on a VM, and its swallowed exit code makes it a
  permanently green check that proves nothing.
- **Trigger-and-poll instead of sync.** `daily.yml` caps curl at 240s; a real ingest across
  86 boards exceeds that, so the job would fail even with correct secrets. The workflows call
  the async endpoint and poll for completion.

---

## 3. Invariants this change must keep

1. **One card.** `JobCardV2` remains the only job card. A surface that needs something it
   cannot show is a reason to extend the card or its data, never to fork it.
2. **`NAV` stays the single nav source.** Sidebar and dock derive from it. A second
   hand-maintained list drifts within a release.
3. **No raw hex in a component** (`docs/UI_SPEC.md`). Colour stays semantic; a match score is
   data and never takes the accent.
4. **Every channel reports its own state.** A source that is unconfigured or failing says so
   in the channels report. Silent skipping is what hid Jooble and Careerjet for months.
5. **A green check must be able to fail.** No workflow step may swallow its exit code.
6. **Routes are not renamed.** The nav move is presentation only.

---

## 4. How it is verified

`frontend/test/responsive.test.mjs` already drives real Chrome at 360/768/1280 against EMPTY
and POPULATED fixtures with the API mocked. It is extended rather than replaced.

**Fixtures gain** saved jobs and applications at the extremes: longest title, unbreakable
company string, zero score, absent score, single item, empty list, promoted vs un-promoted,
and a saved job with no description (the pre-migration shape, which must still render).

**Assertions:**

| Check | Why |
|---|---|
| No horizontal overflow on `/saved`, `/applications`, `/daily`, `/scout` at all three widths, both fixtures | The project rule. Saved jobs previously overflowed by 412px at 360 and this class of bug is invisible with empty data. |
| Card parity — the same card element and class set on every job surface | The thing being asked for; an assertion is the only way it stays true. |
| A saved job with no description renders without "Not mentioned" cells | Proves the degradation path, which is the whole reason old rows keep working. |
| Both themes | Per the project rule. |
| Nav: no top-level Applications; Jobs dock has five items in order | Cheap, and catches a `NAV` edit that half-lands. |

**Backend:** a test asserting `daily_pick` rows are what `/api/daily/picks` returns (the
regression that started this), and a `JoobleConnector` parse test against the captured live
response so a shape change is caught rather than silently returning zero jobs.

**Not testable here:** Careerjet, with no `affid`. It will be left reporting itself as
unconfigured, which is the honest state, and is not mocked into looking like it works.

---

## 5. Sequencing and shipping

Backend DTO and endpoints first (the frontend needs the fields), then the extension capture,
then the card and nav work, then CI. Connectors are independent and can land any time.

Per `CLAUDE.md` → Shipping: the extension change bumps `extension/manifest.json`, and the
frontend and worker changes mean this pass **ships a `desktop-v*` tag**, verified to carry all
three installers. Backend changes reach the VM on push to `master`.

`ARCHITECTURE.md` is updated in the same commit: §5 gains the card contract, and §7's "honest
gaps" loses the items this closes. `AUTOMATION.md` records the Jooble finding, because the
next person to read the Scout comment will otherwise re-derive it.
