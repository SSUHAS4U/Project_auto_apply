# API reference

Base URL: `http://localhost:8080`. All `/api/**` routes require header `X-Api-Token: <token>`.
`/health` is public.

## Auth (public — no token)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/login` | `{email, password}` → `{token, user}`. Throttled per account and per address |
| POST | `/api/auth/register` | `{email, password, fullName}`. Refused (403) once an account exists unless `JOBPILOT_REGISTRATION_OPEN=true` |
| POST | `/api/auth/google` | `{credential}` — the Google Identity Services ID token. Verified server-side; signs in the account with that verified email; creates one only when sign-up is open. 409 if `JOBPILOT_GOOGLE_CLIENT_ID` is unset, 403 for an unknown email while sign-up is closed |
| GET | `/api/auth/config` | `{googleClientId, registrationOpen}` — what the sign-in screens may show. Nothing secret |
| GET | `/api/auth/me` | current user (JWT required) |

## Jobs
| Method | Path | Notes |
|---|---|---|
| GET | `/api/jobs` | filters: `role, location, minScore, applyType, since, page, size` → paged |
| GET | `/api/jobs/{id}` | single job |
| POST | `/api/jobs/{id}/track` | create application (`interested`) |

## Applications
| Method | Path | Notes |
|---|---|---|
| GET | `/api/applications?status=` | list, optional status filter |
| POST | `/api/applications` | `{ jobId?, status?, notes? }` |
| PATCH | `/api/applications/{id}` | `{ status?, notes? }` (logs events) |
| GET | `/api/applications/{id}/timeline` | event audit trail |

Statuses: `interested · applied · interviewing · offer · rejected · withdrawn`.

## Apply (email automation)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/cover-letter/preview` | `{ jobId }` → `{ coverLetter }` |
| POST | `/api/apply/email/{jobId}` | `{ coverLetter? }` → sends resume + letter, marks applied |

## Profile
| Method | Path | Notes |
|---|---|---|
| GET | `/api/profile` | owner profile |
| PUT | `/api/profile` | upsert profile |
| POST | `/api/profile/resume` | multipart `file` |

## Extension sync
| Method | Path | Notes |
|---|---|---|
| POST | `/api/extension/saved-job` | `{ title, company, location, url, sourceSite, raw }` |
| GET | `/api/extension/profile-export` | profile + `field_map` for autofill |

## Saved jobs (dashboard)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/saved-jobs` | captured listings |
| POST | `/api/saved-jobs/{id}/promote` | promote to job + tracked application |

## Notifications
| Method | Path | Notes |
|---|---|---|
| GET | `/api/notifications?unread=` | list + `unreadCount` |
| POST | `/api/notifications/{id}/read` | mark read |

## Ops (cron)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/ingest` | run all connectors; `{ fetched, inserted, updated }` |
| POST | `/api/digest` | send daily digest; `{ count, sent }` |
| POST | `/api/sources/discover` | health-check + auto-discover ATS boards; `{ checked, deactivated, revived, added, activeBoards }` |
| GET | `/api/sources` | full board catalogue with health metadata (active, last job count, failures) |
| POST | `/api/scout/run` | run the job scout now; `{ keywords, found, kept, purged, total }` |
| GET | `/api/scout/jobs` | current scouted listings (LinkedIn/Naukri/Indeed via free APIs, with mined contacts) |

## Resume builder (JWT, per user)
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/resumes` | list / create (`{name, latex?, fromId?, blank?}` — none → profile starter) |
| PUT/DELETE | `/api/resumes/{id}` | rename / edit LaTeX / delete |
| POST | `/api/resumes/{id}/compile` | LaTeX → PDF via free texlive.net; stores + returns the PDF |
| GET | `/api/resumes/{id}/pdf` | last compiled PDF |
| POST | `/api/resumes/{id}/base` | mark as the base (original) resume |
| POST | `/api/resumes/tailor` | `{name?, jobUrl?, jdText}` → AI-tailored copy of the base |
| GET | `/api/extension/resumes` | resume picker options for the extension |

### Example
```bash
curl -X POST http://localhost:8080/api/ingest -H "X-Api-Token: $JOBPILOT_API_TOKEN"
curl "http://localhost:8080/api/jobs?minScore=70&applyType=email" -H "X-Api-Token: $JOBPILOT_API_TOKEN"
```
