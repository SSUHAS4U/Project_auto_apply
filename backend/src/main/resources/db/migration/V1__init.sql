-- JobPilot initial schema. UUID PKs, UTC timestamps.
create extension if not exists "pgcrypto";

-- profile: single row, the owner ------------------------------------------------
create table profile (
    id              uuid primary key default gen_random_uuid(),
    full_name       text not null,
    email           text not null,
    phone           text,
    location        text,
    links           jsonb default '{}'::jsonb,
    skills          text[] default '{}',
    seniority       text,
    experience      jsonb default '[]'::jsonb,
    resume_path     text,
    resume_filename text,
    field_map       jsonb default '{}'::jsonb,
    updated_at      timestamptz default now()
);

-- ats_source: curated company boards to poll -----------------------------------
create table ats_source (
    id          uuid primary key default gen_random_uuid(),
    provider    text not null,                  -- greenhouse | lever | ashby
    board_token text not null,
    company     text not null,
    active      boolean default true,
    created_at  timestamptz default now(),
    unique (provider, board_token)
);

-- job: normalized listings ------------------------------------------------------
create table job (
    id            uuid primary key default gen_random_uuid(),
    source        text not null,
    source_job_id text,
    title         text not null,
    company       text,
    location      text,
    remote        boolean default false,
    description   text,
    url           text not null,
    apply_type    text not null default 'url',   -- email | url | ats | unknown
    apply_email   text,
    salary_text   text,
    posted_at     timestamptz,
    fetched_at    timestamptz default now(),
    content_hash  text not null,
    raw           jsonb,
    match_score   int,
    unique (content_hash)
);
create index idx_job_posted_at on job (posted_at desc);
create index idx_job_match_score on job (match_score desc);
create index idx_job_apply_type on job (apply_type);

-- application: tracked applications --------------------------------------------
create table application (
    id             uuid primary key default gen_random_uuid(),
    job_id         uuid references job(id) on delete cascade,
    status         text not null default 'interested',
        -- interested | applied | interviewing | offer | rejected | withdrawn
    method         text,                          -- email | extension | manual
    applied_at     timestamptz,
    cover_letter   text,
    resume_version text,
    notes          text,
    created_at     timestamptz default now(),
    updated_at     timestamptz default now()
);
create index idx_application_status on application (status);
create index idx_application_job on application (job_id);

-- application_event: audit trail / timeline ------------------------------------
create table application_event (
    id             uuid primary key default gen_random_uuid(),
    application_id uuid references application(id) on delete cascade,
    event_type     text not null,                 -- status_change | email_sent | note
    detail         jsonb,
    created_at     timestamptz default now()
);
create index idx_event_application on application_event (application_id);

-- saved_job: captured by the extension -----------------------------------------
create table saved_job (
    id              uuid primary key default gen_random_uuid(),
    title           text,
    company         text,
    location        text,
    url             text not null,
    source_site     text,
    raw             jsonb,
    promoted_job_id uuid references job(id),
    created_at      timestamptz default now()
);

-- notification ------------------------------------------------------------------
create table notification (
    id         uuid primary key default gen_random_uuid(),
    type       text not null,                      -- new_jobs | digest | reminder
    title      text,
    body       text,
    payload    jsonb,
    read       boolean default false,
    created_at timestamptz default now()
);
create index idx_notification_read on notification (read);

-- Seed an empty owner profile so the dashboard has a row to edit.
insert into profile (full_name, email) values ('Your Name', 'you@example.com');

-- A couple of example ATS boards (deactivated; owner curates real ones).
insert into ats_source (provider, board_token, company, active) values
    ('greenhouse', 'stripe',     'Stripe',     false),
    ('lever',      'leverdemo',  'Lever Demo', false);
