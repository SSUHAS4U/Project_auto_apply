# Daily job runner

`POST /api/daily/run` does everything in one call:
1. **Fetches the latest jobs** from every connector (Adzuna, Jooble, and the Greenhouse boards
   in `ats_source` — Stripe, Databricks, Notion are seeded).
2. **AI-curates** the top new high-match roles into a "Today's top picks" notification + briefing.
3. Sends the **digest email**.

> Honest note: AI does **not** fetch jobs (LLMs can't browse live listings reliably). The
> connectors fetch; the AI ranks/summarizes the best matches for you.

## Three ways to run it daily

### 1. In-app scheduler (simplest — while the backend is running)
Already enabled in `backend/.env`:
```
JOBPILOT_DAILY_CRON=0 0 8 * * *
JOBPILOT_DAILY_ZONE=Asia/Kolkata
```
Fires at 08:00 IST every day **as long as the backend process is up**.

### 2. Windows Task Scheduler (runs even if you forget)
Runs `scripts/daily.ps1` at a fixed time:
```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-ExecutionPolicy Bypass -File `"$PWD\scripts\daily.ps1`""
$trigger = New-ScheduledTaskTrigger -Daily -At 8:00am
Register-ScheduledTask -TaskName "JobPilot Daily" -Action $action -Trigger $trigger
```
(The backend must be running, or have the task start it first.)
Set `JOBPILOT_API_TOKEN` / `JOBPILOT_BACKEND_URL` as user env vars if they differ from defaults.

### 3. GitHub Actions (best for a deployed backend)
`.github/workflows/daily.yml` calls `/api/daily/run` at 08:00 IST. Add repo secrets
`BACKEND_URL` and `API_TOKEN`. Works against a hosted backend even when your PC is off.

## Manual run any time
```bash
./scripts/daily.sh                 # bash
powershell -ExecutionPolicy Bypass -File scripts/daily.ps1   # windows
```
Or just click **Run ingest** in the dashboard, then check the **Notifications** tab for picks.

---

## Sync secrets to Render (deployment)

`scripts/render-sync-env.ps1` reads your local `backend/.env` and pushes **only the secret
keys** (API tokens, mail creds) to Render via their REST API — secrets **never touch Git**.

### Setup (one-time)
1. Get a Render API key: https://dashboard.render.com/account/api-keys
2. Find your service ID in the Render dashboard URL: `srv-xxxxxxxxx`
3. Set env vars (or pass as params):
```powershell
$env:RENDER_API_KEY    = "rnd_xxxxxxxxxxxxxxxx"
$env:RENDER_SERVICE_ID = "srv-xxxxxxxxxxxxxxxxxx"
```

### Run
```powershell
powershell -ExecutionPolicy Bypass -File scripts/render-sync-env.ps1
```

### What it syncs
Only sensitive keys: `JOBPILOT_API_TOKEN`, `JOBPILOT_GROQ_API_KEY`, `JOBPILOT_GEMINI_API_KEY`,
`JOBPILOT_BREVO_API_KEY`, `JOBPILOT_ADZUNA_APP_ID/KEY`, `JOBPILOT_JOOBLE_KEY`, mail credentials.
Non-secret config (model names, cron, CORS) stays in `render.yaml` as-is.

### Alternative: Admin UI
The deployed app also has an **Admin → API keys & secrets** panel where you can paste keys directly.
They're stored AES-256 encrypted in the database and persist across redeployments.
