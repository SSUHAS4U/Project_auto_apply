-- HireDue autonomous agent: a LOCAL Playwright worker (on the owner's PC) drives
-- the real job portals (Naukri -> LinkedIn -> Indeed on a daily rotation) while the
-- backend stays the brain (schedule, AI, records, metrics) and the dashboard watches
-- it live. These tables are ADDITIVE — the pilot_* pipeline tables are untouched and
-- their AI stages (evaluate/draft/review/tailor) are reused by the worker.

-- One user's daily rotation config: ordered portal blocks (Naukri 09:00 for 120m, ...).
create table if not exists agent_schedule (
    id uuid primary key,
    user_id uuid not null,
    portal text not null,                 -- naukri | linkedin | indeed
    ord int not null default 0,           -- rotation order
    start_time text,                      -- "09:00" local; null = right after previous block
    duration_mins int not null default 120,
    keywords text,                        -- comma list; blank = derive from profile
    locations text,                       -- comma list of search locations (multi-location)
    apply_cap int not null default 200,   -- per-block daily caps
    connect_cap int not null default 100,
    message_cap int not null default 50,
    enabled boolean not null default true,
    updated_at timestamptz not null default now()
);
create index if not exists idx_agent_schedule_user on agent_schedule (user_id, ord);

-- One portal session instance the worker runs (a "block" actually executing).
create table if not exists agent_run (
    id uuid primary key,
    user_id uuid not null,
    portal text not null,
    status text not null default 'queued',  -- queued | running | paused | needs_attention | done | failed
    current_action text,                    -- human-readable "what it's doing now"
    started_at timestamptz,
    ended_at timestamptz,
    searched int not null default 0,
    evaluated int not null default 0,
    applied int not null default 0,
    connected int not null default 0,
    messaged int not null default 0,
    skipped int not null default 0,
    failed int not null default 0,
    note text,
    created_at timestamptz not null default now()
);
create index if not exists idx_agent_run_user on agent_run (user_id, created_at desc);
create index if not exists idx_agent_run_status on agent_run (user_id, status);

-- Atomic actions the worker pulls and executes (built from top-ranked jobs each block).
create table if not exists agent_task (
    id uuid primary key,
    run_id uuid references agent_run(id) on delete cascade,
    user_id uuid not null,
    portal text not null,
    kind text not null,                     -- apply | connect | message | search
    status text not null default 'pending', -- pending | in_progress | done | skipped | failed
    job_id uuid,                            -- source job (if any)
    application_id uuid,
    job_title text,
    job_company text,
    job_location text,
    job_url text,
    match_score int,
    payload text,                           -- JSON: tailored resume ref, message body, answers, etc.
    result text,                            -- JSON: outcome details
    error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_agent_task_run on agent_task (run_id);
create index if not exists idx_agent_task_pull on agent_task (user_id, portal, status, created_at);

-- Event stream feeding the dashboard timeline + all metric counters.
create table if not exists agent_event (
    id uuid primary key,
    user_id uuid not null,
    run_id uuid,
    task_id uuid,
    portal text,
    type text not null,                     -- post_analysed | job_identified | relevant | applied
                                            -- | connection_sent | message_sent | email_sent
                                            -- | reply_received | easy_apply | error | info
    title text,                             -- job/person title for the "recent actions" list
    company text,
    url text,
    detail text,
    created_at timestamptz not null default now()
);
create index if not exists idx_agent_event_user on agent_event (user_id, created_at desc);
create index if not exists idx_agent_event_type on agent_event (user_id, type, created_at desc);

-- People discovered on the portals (recruiters/hiring managers) — the Network CRM.
create table if not exists portal_contact (
    id uuid primary key,
    user_id uuid not null,
    portal text not null,
    name text,
    profile_url text,
    company text,
    role text,
    source_job_url text,
    connection_status text not null default 'none',  -- none | pending | connected | replied
    last_message_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_portal_contact_user on portal_contact (user_id, updated_at desc);
create unique index if not exists uq_portal_contact on portal_contact (user_id, portal, profile_url);

-- Threaded messages per contact. Recruiter replies are DRAFT-FIRST: AI drafts, owner approves.
create table if not exists agent_message (
    id uuid primary key,
    user_id uuid not null,
    contact_id uuid references portal_contact(id) on delete cascade,
    portal text,
    direction text not null,                -- in | out
    body text,
    status text not null default 'draft',   -- draft | pending_approval | approved | sent | received
    ai_drafted boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_agent_message_user on agent_message (user_id, updated_at desc);
create index if not exists idx_agent_message_contact on agent_message (contact_id, created_at);

-- Latest live screenshot per user (single row upserted ~1/sec) for the Watch Live panel.
create table if not exists live_frame (
    user_id uuid primary key,
    run_id uuid,
    portal text,
    action text,                            -- current action caption
    image_b64 text,                         -- downscaled JPEG, base64
    updated_at timestamptz not null default now()
);
