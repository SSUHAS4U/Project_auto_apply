# Setup, connector keys & deployment

## Connector credentials (all free; optional)

| Connector | How to get keys | Env vars |
|---|---|---|
| **Greenhouse** | None — public boards | curate boards via `ats_source` table |
| **Lever** | None — public postings | curate boards via `ats_source` table |
| **Ashby** | None — public job board API | curate boards via `ats_source` table |
| **Adzuna** | https://developer.adzuna.com (free app_id + app_key) | `JOBPILOT_ADZUNA_APP_ID`, `JOBPILOT_ADZUNA_APP_KEY`, `JOBPILOT_ADZUNA_QUERIES`, `JOBPILOT_ADZUNA_WHERE`, `JOBPILOT_ADZUNA_COUNTRY` |
| **Jooble** | https://jooble.org/api/about (free key) | `JOBPILOT_JOOBLE_KEY`, `JOBPILOT_JOOBLE_KEYWORDS` |

Connectors with no/blank credentials are skipped automatically — ingest never fails because one
source is unconfigured.

### Adding ATS boards (Greenhouse / Lever / Ashby)
Insert rows into `ats_source` (provider, board_token, company, active):
```sql
insert into ats_source (provider, board_token, company, active) values
  ('greenhouse', 'airbnb',   'Airbnb',   true),
  ('lever',      'netflix',  'Netflix',  true),
  ('ashby',      'ramp',     'Ramp',     true);
```
- `board_token` is the slug in the board URL (e.g. `boards.greenhouse.io/airbnb` → `airbnb`).

## Email (Gmail SMTP)
1. Enable 2FA on your Google account.
2. Create an **App password** (Security → App passwords).
3. Set `SPRING_MAIL_USERNAME`, `SPRING_MAIL_PASSWORD` (the 16-char app password), `JOBPILOT_MAIL_FROM`.

## Cover-letter provider
- `template` (default) — no dependencies, deterministic mail-merge.
- `ollama` — run `ollama serve` locally, `ollama pull llama3.1`, set `JOBPILOT_COVERLETTER_PROVIDER=ollama`.
- `gemini` — set `JOBPILOT_GEMINI_API_KEY` and `JOBPILOT_COVERLETTER_PROVIDER=gemini`.
Any provider failure falls back to the template automatically.

## Deployment

### Backend (Render / Railway / Fly.io free)
- A [`backend/Dockerfile`](../backend/Dockerfile) is included. Point the host at it.
- Set all env vars from `.env.example` in the host dashboard.
- Set `PORT` if the platform injects one (the app honors `${PORT}`).

### Frontend (Vercel / Netlify free)
- Build command `npm run build`, output `dist/`, root `frontend/`.
- Env: `VITE_API_BASE` = your backend URL. (Token is entered at runtime in Settings.)

### Cron (GitHub Actions)
Add repo secrets **BACKEND_URL** and **API_TOKEN**. The
[`ingest`](../.github/workflows/ingest.yml) and [`digest`](../.github/workflows/digest.yml)
workflows run on schedule and can be triggered manually via *Run workflow*.

## Running tests / build locally
```bash
cd backend && ./mvnw verify        # 9 unit tests
cd frontend && npm run build       # type-check + bundle
```
