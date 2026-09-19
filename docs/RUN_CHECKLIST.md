# What to check on the next real run

Everything below was fixed against evidence in the log, and **none of it has been seen working
against live LinkedIn or Indeed** — that is what this run is for. Each row says what to look for,
what it means if it is wrong, and where to look next. The full log is at
`%LOCALAPPDATA%\JobPilot\logs\jobpilot-<date>.log`.

Build required: **desktop-v158 or later**. Check the first line of the log (`build …`).

---

## A. Does the search actually search?

| # | What you should see | What it means if you don't |
|---|---|---|
| A1 | A search finds **more than 1 job** — typically 5–25 | Still capped at 1 → the results list is not rendering. Look for `SEARCH_LIST_NOT_READ` in the log. |
| A2 | **Different cities give different jobs** | Same job ids across cities → the location filter is still being dropped. Look for `SEARCH_FILTER_DROPPED`. |
| A3 | `[search] {"outcome":"attempt",…,"filterKept":true}` | `filterKept:false` on BOTH forms means LinkedIn changed again — the fault will say so. |
| A4 | `[search]` shows `form:"search-results"` OR `form:"search"` | Whichever wins is fine. If it always falls through to the second, the first form is dead for now. |

**Fastest check:** `grep -o '"filterKept":[a-z]*' <log> | sort | uniq -c`

---

## B. Is the job being read properly?

| # | What you should see | What it means if you don't |
|---|---|---|
| B1 | `[posting]` records with **`chars` in the thousands** | Still ~100 → the description read is still failing; the `sample` field now shows exactly what it grabbed. |
| B2 | **Fit scores that VARY** — 30s, 50s, 70s | Every job scoring the same number means it is judging a fragment again. |
| B3 | No `DESCRIPTION_TOO_SHORT` faults | If present, read its `sample` — it names the text that was picked up instead. |

**Fastest check:** `grep -o '"chars":[0-9]*' <log> | sort -t: -k2 -n | tail`

---

## C. Do applications actually submit?

| # | What you should see | What it means if you don't |
|---|---|---|
| C1 | `✓ resume attached by the portal: <name>` | `no resume name visible` is not a failure — the application should still proceed. |
| C2 | **No pause mentioning the resume** | If one appears, the old build is still installed. Check the build line. |
| C3 | At least one `applied` result | If everything still pauses, the reason printed will now name the real cause (a question, a checkpoint, an external form). |
| C4 | The applied event carries `resume: <name>` | Confirms which CV went out, per application. |

---

## D. Does the run survive its browser?

The browser died twice in 74 minutes on 14 Aug, once while merely idle. It may well die again —
**that is now expected, not a failure.** What matters is what happens next.

| # | What you should see | What it means if you don't |
|---|---|---|
| D1 | `⟳ … reopening and CONTINUING this block (attempt 2 of 3)` | The word **CONTINUING** matters. "retrying" is the old build. |
| D2 | After a restart, Easy Apply shows **less than its full budget**, or is skipped with `its 90m were already used` | A fresh `max 90m` after a crash means the budget is restarting again. |
| D3 | `[lifecycle] browser died mid-block — continuing` with `phase1SpentMs` | This is the number that proves the budget carried over. |

---

## E. Do the other three flows finally run?

These have **never executed**. This is the headline result of the run.

| # | What you should see |
|---|---|
| E1 | `══ Post scan → apply — up to Nm ══` |
| E2 | `══ Recruiter email — up to Nm ══` |
| E3 | `══ Connections — up to Nm ══` |

If Easy Apply still consumes everything, D2 is where the cause will be.

---

## F. Pacing and bot detection

| # | What you should see | Notes |
|---|---|---|
| F1 | `· LinkedIn challenged N request(s) … waiting an extra Nm` | The gap now grows with the challenge rate. Seeing this is the mechanism working. |
| F2 | Total challenges **lower than 37 per 74 minutes** | If it climbs anyway, the answer is fewer searches per run, not slower ones. |

**Fastest check:** `grep -c "uc=scraping" <log>`

---

## G. Accounting

| # | What you should see | What it means if you don't |
|---|---|---|
| G1 | A `[ledger]` record **even if the run crashes** | Missing → the failure path is not sealing it. |
| G2 | The ledger's dominant reason names something real | "paused with no reason recorded" means a code path exits without saying why. |

---

## H. Indeed

Indeed has **never run** — Easy Apply on LinkedIn always ended the block first. If E1–E3 pass,
Indeed should get a block of its own.

| # | What you should see |
|---|---|
| H1 | `▶ INDEED — starting` |
| H2 | Searches finding jobs, and at least one submission |

---

## Known-unfixed / expected

- **The browser dying is not fixed** — only survived. The cause is upstream in Camoufox/Firefox
  and there is no evidence yet of *why* it dies while idle. If it dies more than 3 times in a
  block, the block still fails.
- **Search yield** may stay low even with the filter fixed, if LinkedIn's Easy-Apply inventory
  for these keyword/city pairs is genuinely thin. A1 distinguishes the two: 1 result every time
  is a bug, 3–4 results sometimes is the market.

---

## The one-line triage

If the run disappoints, run this first — it answers most of the above at once:

```sh
grep -o '\[fault\] {"id":"[A-Z_]*"' <log> | sort | uniq -c
```

Every fault carries what happened, why, and what to do. If a fault fires that has no guidance
registered, that is itself reported as a bug.
