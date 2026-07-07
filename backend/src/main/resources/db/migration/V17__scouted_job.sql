-- Scouted jobs: the automated scout runs 4-5x/day, searches LinkedIn/Naukri/Indeed/
-- Google (via free APIs) with resume keywords, and lands refined results here —
-- a separate section from the main ingested board.
create table if not exists scouted_job (
    id uuid primary key,
    title text not null,
    company text,
    location text,
    url text not null,
    url_hash text not null unique,
    source_site text,
    snippet text,
    emails text,
    phones text,
    matched_keywords text,
    match_score int,
    posted_hint text,
    fetched_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);
create index if not exists idx_scouted_job_fetched on scouted_job (fetched_at desc);
create index if not exists idx_scouted_job_score on scouted_job (match_score desc);
