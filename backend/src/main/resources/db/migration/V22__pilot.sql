-- Auto Apply v2 ("Pilot"): a per-job multi-stage pipeline modeled on the
-- ai-job-search framework: evaluate (6-dimension weighted fit) -> draft tailored
-- CV + cover letter -> independent reviewer critique -> revise -> compile PDF ->
-- ATS text-layer verification + keyword coverage -> submit / queue -> track.
-- The dashboard only OBSERVES this pipeline (plus pause/resume).

-- Replaces the v1 flat engine.
drop table if exists auto_apply_item;
drop table if exists auto_apply_run;

create table if not exists pilot_cycle (
    id uuid primary key,
    user_id uuid,
    run_trigger text not null default 'scheduled',  -- scheduled | manual
    status text not null default 'running',         -- running | completed | failed
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    scanned int not null default 0,        -- fresh jobs considered
    picked int not null default 0,         -- entered the pipeline this cycle
    evaluated int not null default 0,
    submitted int not null default 0,
    queued int not null default 0,
    skipped int not null default 0,
    failed int not null default 0,
    summary text,
    error text
);
create index if not exists idx_pilot_cycle_started on pilot_cycle (started_at desc);

create table if not exists pilot_job (
    id uuid primary key,
    cycle_id uuid references pilot_cycle(id) on delete set null,
    user_id uuid,
    job_id uuid,
    application_id uuid,
    -- denormalised posting facts (survive the 7-day job purge)
    job_title text,
    job_company text,
    job_location text,
    job_url text,
    job_apply_type text,
    job_apply_email text,
    match_score int,                        -- ingest quick score (scrape-stage fit)
    -- pipeline state machine
    stage text not null default 'scraped',  -- scraped | evaluated | drafted | reviewed
                                            -- | revised | compiled | verified
                                            -- | submitted | queued | skipped | failed
    stage_log text,                         -- JSON array [{stage,at,note}]
    skip_reason text,
    error text,
    -- stage artifacts
    evaluation text,                        -- JSON: 6 dimensions, weighted score, verdict, keywords
    fit_score int,                          -- weighted 0-100
    verdict text,                           -- strong | good | moderate | weak | poor
    cv_latex text,
    cover_letter text,
    reviewer_feedback text,                 -- Part A (JSON edits) + Part B (narrative)
    revision_notes text,
    ats_report text,                        -- JSON: contact/garbage checks + coverage table
    tailoring_summary text,                 -- 3-5 key tailoring decisions
    cv_pdf bytea,
    cover_pdf bytea,
    -- queued items (extension picks these up)
    queue_status text,                      -- pending | opened | applied | dismissed
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_pilot_job_cycle on pilot_job (cycle_id);
create index if not exists idx_pilot_job_user_job on pilot_job (user_id, job_id);
create index if not exists idx_pilot_job_stage on pilot_job (user_id, stage);
create index if not exists idx_pilot_job_queue on pilot_job (user_id, queue_status);
create index if not exists idx_pilot_job_created on pilot_job (created_at desc);
