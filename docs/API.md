# API reference

Base URL: `http://localhost:8080`. All `/api/**` routes require header `X-Api-Token: <token>`.
`/health` is public.

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

### Example
```bash
curl -X POST http://localhost:8080/api/ingest -H "X-Api-Token: $JOBPILOT_API_TOKEN"
curl "http://localhost:8080/api/jobs?minScore=70&applyType=email" -H "X-Api-Token: $JOBPILOT_API_TOKEN"
```
