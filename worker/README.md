# JobPilot Worker

The local automation worker. It runs a **real Chromium browser on your PC** with your
own logged-in Naukri/LinkedIn/Indeed sessions, so applying happens from your home IP with
your real accounts — the safest and only truly-free way to automate the portals. The
JobPilot backend stays the brain (schedule, AI fit-scoring, answers, records, metrics)
and the dashboard shows a **live screen feed** of what the worker is doing.

No portal passwords are ever sent to the backend. You log in yourself, in the browser
this opens, once — the session is remembered in `worker/.profile/`.

## Setup — one double-click

Requires **Node 18+** (get it once from https://nodejs.org — the "LTS" button).

- **Windows:** double-click **`start-jobpilot.bat`**
- **Mac / Linux:** run **`./start-jobpilot.sh`**

The first run installs everything (incl. a private Chromium ~150 MB) and then asks for a
**connect code**. Get it from the dashboard: **Agent → Connect → Generate connect code**,
paste it in, and you're done — it's remembered, so next time it just opens.

A browser window opens. Sign into the portals you want (Naukri / LinkedIn / Indeed) — once;
the logins are saved on your PC. Then use the **Connect** buttons on the dashboard's
Connections page, or hit **▶ Start** for a portal on the Agent page. Watch it live in the
**Watch Live** panel; **Pause** stops it promptly.

Advanced: instead of the connect code you can set `JOBPILOT_BACKEND_URL` +
`JOBPILOT_WORKER_TOKEN` env vars, or create `worker.config.json` yourself.

## Safety & scope

- **Native applies only.** "Apply on company site" (external) listings are skipped and
  left for the backend's tailored-email path — the worker never fills unknown external
  sites blindly.
- **Honest answers.** Screening questions are answered only from your profile; anything
  the profile can't support is flagged "needs attention" instead of invented.
- **Draft-first messaging.** Connection notes and recruiter replies are AI-drafted and
  wait for your approval in the dashboard before the worker sends them.
- **Human-paced.** Randomized delays and per-block caps; stops immediately on Pause.

## Portals

All three drive the portal's **native** apply (never external employer sites):

- **Naukri** — search → open → fit-check → Apply (+ screening chatbot).
- **LinkedIn** — searches with the **Easy Apply** filter, walks the multi-step Easy Apply
  modal, answers questions, uploads resume, submits.
- **Indeed** — Indeed Apply / smartapply multi-step flow; stops and flags "needs attention"
  on a captcha/checkpoint (solve it in the browser and it resumes).

Log into each portal once in the browser this opens; the sessions persist. Start a portal
run from the dashboard (▶ naukri / linkedin / indeed) or let the daily rotation schedule
drive them.
