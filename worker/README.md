# JobPilot Worker

The local automation worker. It runs a **real Chromium browser on your PC** with your
own logged-in Naukri/LinkedIn/Indeed sessions, so applying happens from your home IP with
your real accounts — the safest and only truly-free way to automate the portals. The
JobPilot backend stays the brain (schedule, AI fit-scoring, answers, records, metrics)
and the dashboard shows a **live screen feed** of what the worker is doing.

No portal passwords are ever sent to the backend. You log in yourself, in the browser
this opens, once — the session is remembered in `worker/.profile/`.

## Setup

Requires **Node 18+**.

```bash
cd worker
npm install          # also downloads a private Chromium (~150 MB)
```

Connect it to your account:

1. In the dashboard open **Auto Apply → Agent → Connect worker** and click **Generate
   token**. Copy the token (shown once).
2. Create `worker/worker.config.json`:

```json
{
  "backendUrl": "https://your-backend.onrender.com",
  "token": "PASTE_THE_TOKEN_HERE"
}
```

(or set `JOBPILOT_BACKEND_URL` and `JOBPILOT_WORKER_TOKEN` as environment variables.)

## Run

```bash
npm start
```

A browser window opens on `naukri.com`. **Log in** (first time only). Then in the
dashboard hit **Start Naukri** — the worker picks up the run, searches your keywords
across your locations, opens matches, checks fit, and applies via Naukri's native
Apply (answering the screening chatbot from your profile). Watch it live in the
dashboard's **Watch Live** panel. Hit **Pause** any time to stop it promptly.

## Safety & scope

- **Native applies only.** "Apply on company site" (external) listings are skipped and
  left for the backend's tailored-email path — the worker never fills unknown external
  sites blindly.
- **Honest answers.** Screening questions are answered only from your profile; anything
  the profile can't support is flagged "needs attention" instead of invented.
- **Draft-first messaging.** Connection notes and recruiter replies are AI-drafted and
  wait for your approval in the dashboard before the worker sends them.
- **Human-paced.** Randomized delays and per-block caps; stops immediately on Pause.

## Status

Naukri is the first portal implemented end-to-end. LinkedIn and Indeed adapters follow
the same shape (`src/portals/*.js`) and are next.
