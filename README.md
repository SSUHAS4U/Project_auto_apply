# JobPilot 🧭

A personal, single-user **job aggregator + application tracker + assisted-apply browser extension**.
Built to run on free tiers. Spring Boot API · React dashboard · Chrome MV3 extension.

> **Design principle:** the only fully-automated apply path is **email** (sent from your own
> mailbox). For LinkedIn/Naukri/Indeed/Google Forms/MS Forms the extension *fills* the form and
> **you review & submit** — no unattended submission, no server-side scraping of those platforms.

---

## What's in the box

| Component | Stack | Folder |
|---|---|---|
| Backend API | Spring Boot 3.3 · Java 21 · JPA · Flyway · Postgres | [`backend/`](backend/) |
| Dashboard | React 18 · Vite · TypeScript | [`frontend/`](frontend/) |
| Extension | Chrome MV3 (vanilla JS) | [`extension/`](extension/) |
| Automation | GitHub Actions cron (ingest + digest) | [`.github/workflows/`](.github/workflows/) |

All five build phases from the spec are implemented: scaffold, aggregator+tracker, match+profile,
email-apply+cover-letters, notifications+digest, and the browser extension.

---

## Quick start (local)

### 1. Database
Use Supabase Postgres (free) **or** local Postgres:
```bash
docker compose up -d        # starts Postgres on :5432
```

### 2. Backend
```bash
cd backend
cp ../.env.example .env      # then edit values (DB url, API token, mail, connector keys)
# load .env into your shell (Git Bash):
set -a && . ./.env && set +a
./mvnw spring-boot:run        # http://localhost:8080/health
```
Flyway creates the schema on first boot and seeds an empty owner profile.

### 3. Dashboard
```bash
cd frontend
cp .env.example .env.local    # set VITE_API_BASE + VITE_API_TOKEN (= backend JOBPILOT_API_TOKEN)
npm install
npm run dev                   # http://localhost:5173
```
Open **Settings** in the dashboard and paste your API token, then **Test connection**.

### 4. Extension
1. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select [`extension/`](extension/).
2. Click the JobPilot icon → **Options** → set Backend URL (`http://localhost:8080`) + API token → **Test connection**.

See [`docs/EXTENSION.md`](docs/EXTENSION.md) for usage and [`docs/SETUP.md`](docs/SETUP.md) for connector keys & deployment.

---

## How it works

```
GitHub cron → POST /api/ingest → connectors (Greenhouse/Lever/Ashby/Adzuna/Jooble)
            → normalize + dedupe (content_hash) + classify apply_type + match score → Postgres
Dashboard  → browse / filter / track / email-apply / manage pipeline
Extension  → autofill forms (you submit) + "Save to JobPilot" capture
GitHub cron → POST /api/digest → daily high-match email + in-app notification
```

- **Apply routing:** every job has `apply_type` ∈ `email | url | ats | unknown`.
  `email` jobs can be applied to automatically (resume + tailored cover letter via SMTP).
- **Cover letters:** pluggable provider — `ollama` (local, default-capable), `gemini` (free tier),
  or `template` (deterministic fallback). Configured by `JOBPILOT_COVERLETTER_PROVIDER`.
- **Auth:** every `/api/**` route requires header `X-Api-Token` (constant-time check). Single static token.

---

## Security

- Secrets live in `.env` / host env only; `.env.example` is the template. Never commit real values.
- Resume stored outside the repo (`./uploads`, git-ignored) — swappable for a Supabase private bucket.
- CORS locked to the dashboard origin + `chrome-extension://*`.
- Email-apply is rate-limited (`JOBPILOT_MAIL_DAILY_LIMIT`) and always owner-confirmed.
- Extension stores its token in `chrome.storage.local`, never in source.

See [`docs/API.md`](docs/API.md) for the full endpoint reference.

## Honest limitations
- Free job feeds (Greenhouse/Lever/Adzuna…) are a clean, recent slice — not the full LinkedIn/Naukri volume.
- "Auto apply" is automatic **only** for email-type jobs; everything else is autofill + your click.
- Per-site extension selectors break when sites change markup; the generic label matcher keeps most fields working.
- Free backend hosts sleep → first request after idle lags a few seconds. The cron wakes it for ingest.
