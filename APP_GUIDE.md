# JobPilot — Full Application Guide

Everything about the app in one place: what each screen does, how matching works, the AI
features, the extension, and how to run it. (For setup/deploy details see [docs/SETUP.md](docs/SETUP.md);
for the API see [docs/API.md](docs/API.md).)

---

## 1. What JobPilot is
A personal, single-user job **aggregator + tracker + AI assistant + assisted-apply extension**.
It pulls real jobs from free legal sources, scores them against *your* resume, lets you track
applications, and uses AI (Groq / Gemini / Ollama) to write cover letters, cold emails, and a daily
shortlist. Runs locally for ₹0.

## 2. Starting it
```powershell
# from d:\Project_auto_apply
powershell -ExecutionPolicy Bypass -File start.ps1
```
Backend → http://localhost:8080 · Dashboard → http://localhost:5173 · token from your `.env` file.
The backend uses an in-process Postgres (no Docker needed); data persists in `backend/.embedded-pg`.

## 3. The screens (left nav)
| Screen | Purpose |
|---|---|
| **Jobs** | All aggregated jobs. Tabs: **All · India + Remote · Outside India**. Filter by role/location/score/apply-type. Click a title for full details; **Track** to add to pipeline; **Apply** (email jobs). |
| **Daily picks** ☀️ | AI-curated top matches generated every morning at 09:00 (or **Run now**). A *separate* review area — verify each before applying. |
| **Assistant** 🤖 | Chat to find jobs ("remote java fresher roles") and get profile help. Searches your own job DB. |
| **Compose & send** ✍️ | Paste a role + job details → AI writes a **subject + cold email + cover letter** from your templates → review → send with your resume attached. |
| **Applications** | Detailed table of tracked apps with inline status, match, apply type, dates; filter tabs; Details modal with timeline, notes, cover letter. |
| **Saved** 🔖 | Listings captured by the browser extension from LinkedIn/Naukri/Indeed. Promote them to tracked jobs. |
| **Notifications** | New-job alerts, daily-pick summaries, ingest/rescore completions. |
| **Profile** | Tabbed: Personal / Professional / Experience / Education / Autofill answers / Resume. Drives matching, cover letters, and extension autofill. **Smart auto-fill**: upload a PDF/DOCX → AI extracts and fills the fields. |
| **Settings** | API token; **AI model switch** (Auto / Groq / Gemini / Ollama) with per-model **Test connection**. |

## 4. How job matching works (resume-aware)
Each job gets a 0–100 `match_score` tuned for an **early-career candidate**:
- **Skills** (45): overlap with your profile skills.
- **Experience fit** (30): rewards *fresher / new-grad / junior / 0–2 yr* roles; **penalises** senior /
  lead / staff / principal / manager titles and roles demanding many years (parses "5+ years" etc.).
- **Region fit** (15): **India boosted**, then **Remote**, foreign on-site lowest.
- **Recency** (10).

Your profile drives it — set **seniority = entry** and **years = ~1** (Nokia internship) so the engine
favours roles you can actually get. After changing your profile, run **Settings → (or) `POST /api/maintenance/rescore`**
to re-score the whole DB. Jobs are tagged `region = india | remote | outside | unknown` for the tabs.

## 5. AI features & models
- **Provider switch** in Settings: **Auto** (first configured: Groq→Gemini→Ollama), **Groq** (llama-3.3-70b,
  fast), **Gemini** (gemini-2.5-flash), **Ollama** (local). Test each with one click.
- **Cost guardrail**: hard cap `JOBPILOT_AI_DAILY_LIMIT` (default 80 AI calls/day). Email sends capped too.
- Used for: cover letters, **Compose** (subject + cold email + cover letter from your templates),
  **Daily picks** briefing, **Assistant** chat, profile **AI-suggest**, and **resume auto-fill**.
- **Templates**: your email + cover-letter templates live on the Profile (Professional tab → cover-letter
  notes, and the email template). The AI **rewrites them per company/role** and generates the subject.

## 6. Applying to jobs — the three paths
1. **Email jobs** (`apply_type=email`): one click sends your resume + tailored cover letter from your Gmail.
2. **Compose & send**: for any job, generate + send a cold email yourself.
3. **URL/ATS jobs**: open the posting and apply on the site; the **extension** autofills the form.

> Honest limit: there is **no legal/free way for a server to pull fresh LinkedIn/Naukri/Indeed postings**
> (scraping is against their terms; Google's Custom Search API was closed to new projects in Jan 2026).
> So those are handled by the **extension** (you browse, it captures/fills). The server sources are
> Adzuna, Jooble, Remotive, Arbeitnow, Jobicy, RemoteOK + 59 Greenhouse/Lever/Ashby company boards.

## 7. Browser extension (autofill + capture)
**Install:** Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`.
**Connect:** click the JobPilot icon → **Options** → Backend `http://localhost:8080`, token
your `JOBPILOT_API_TOKEN` from `.env` → **Test connection**.

**Use it:**
- **Autofill a form** (Google Forms, MS Forms, ATS, generic): open the form → JobPilot icon → **⚡ Fill this
  form**. Filled fields highlight; a badge shows "filled N of M — review & submit". You submit.
- **Save a listing**: on a LinkedIn/Naukri/Indeed job page a **🔖 Save to JobPilot** button appears →
  it pushes the listing to the **Saved** tab → **Promote** to a tracked application.
- **Custom questions**: add `keyword → answer` pairs under Profile → **Autofill answers**; the extension
  matches them on any form.

**How to test the extension fills forms (quick):**
1. Load it + connect (above), and make sure your Profile has name/email/phone/skills.
2. Open any **Google Form** with name/email/phone questions (make a 3-question test form).
3. Click the extension → **⚡ Fill this form** → watch the fields populate + the badge appear.
4. For capture: open a LinkedIn job page → click **🔖 Save to JobPilot** → check the **Saved** tab in the dashboard.

## 8. Daily automation
`POST /api/daily/run` (09:00 IST in-app, or GitHub Action / Windows Task Scheduler — see
[scripts/README.md](scripts/README.md)) fetches latest jobs → AI-curates Daily Picks → digest email →
purges jobs older than 7 days (untracked only) to keep the DB lean.

## 9. Performance notes
- 9,000+ jobs across 67 sources. **Ingest runs in the background** (returns instantly, notifies on
  completion, dashboard auto-refreshes). Sources are fetched concurrently.
- `/api/ingest` & `/api/daily/run` are async; `/sync` variants exist for cron/scripts.

## 10. What you provide (already wired in `backend/.env`, git-ignored)
Gmail app password, Adzuna app_id/key, Jooble key, Groq key, Gemini key. Ollama optional (local).
See [README.md](README.md) for the credential list and [docs/SETUP.md](docs/SETUP.md) for how to get them.

## 11. Known limitations / honest notes
- "Auto apply" is fully automatic **only** for email-type jobs; everything else is autofill + your click.
- LinkedIn/Naukri/Indeed deep-links from aggregators (Adzuna/Jooble) can occasionally be stale redirects —
  use the extension to capture live ones.
- Mobile: the dashboard is responsive and usable in a phone browser; the extension is desktop-Chrome only.
- AI quality depends on the provider; always review generated emails before sending.
