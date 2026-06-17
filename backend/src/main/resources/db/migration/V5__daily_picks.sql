-- AI-curated daily picks, kept separate from the main job board so they can be
-- reviewed before applying. Replaced on each daily run.
create table daily_pick (
    id         uuid primary key default gen_random_uuid(),
    job_id     uuid references job(id) on delete cascade,
    rank       int,
    run_at     timestamptz default now(),
    created_at timestamptz default now()
);
create index idx_daily_pick_run on daily_pick (run_at desc);
