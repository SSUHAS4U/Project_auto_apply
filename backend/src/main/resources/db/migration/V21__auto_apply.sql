-- Auto Apply module: a daily pipeline that scans fresh matched jobs, tailors a
-- cover letter, auto-sends email-type applications, and queues ATS/URL jobs for
-- the extension. Every decision is recorded with a reason.

create table if not exists auto_apply_run (
    id uuid primary key,
    user_id uuid,
    run_trigger text not null default 'scheduled',   -- scheduled | manual
    status text not null default 'running',      -- running | completed | failed
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    considered int not null default 0,
    emails_sent int not null default 0,
    queued int not null default 0,
    skipped int not null default 0,
    failed int not null default 0,
    summary text,
    error text
);
create index if not exists idx_auto_apply_run_started on auto_apply_run (started_at desc);

create table if not exists auto_apply_item (
    id uuid primary key,
    run_id uuid references auto_apply_run(id) on delete cascade,
    user_id uuid,
    job_id uuid,
    application_id uuid,
    action text not null,        -- email_sent | queued | skipped | failed
    reason text,                 -- human-readable why (applied / skipped / failed)
    letter_kind text,            -- ai | template (email sends only)
    match_score int,
    -- denormalised so history survives the 7-day job purge
    job_title text,
    job_company text,
    job_url text,
    job_apply_type text,
    queue_status text,           -- queued items: pending | opened | applied | dismissed
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_auto_apply_item_run on auto_apply_item (run_id);
create index if not exists idx_auto_apply_item_user_job on auto_apply_item (user_id, job_id);
create index if not exists idx_auto_apply_item_queue on auto_apply_item (user_id, queue_status);
create index if not exists idx_auto_apply_item_created on auto_apply_item (created_at desc);
