-- The Engine: a CLEAN-ROOM replica of MadsLorentzen/ai-job-search inside this app.
-- Entirely separate component from JobPilot's existing job flow: its own profile docs,
-- its own scraper (LinkedIn guest, like the repo's linkedin-search CLI), its own
-- rank/apply/outcome/interview/upskill pipeline and its own tables. It shares only
-- generic resources (AI client, LaTeX compile, PDF tools, mail, DB, auth, dashboard).

-- /setup — the repo's profile FILES as one row of documents per user:
-- CLAUDE.md + 01..07 skill files + search-queries.md.
create table if not exists engine_profile (
    id uuid primary key,
    user_id uuid not null unique,
    candidate_md text,          -- 01-candidate-profile.md  (education, experience, skills)
    behavioral_md text,         -- 02-behavioral-profile.md (work style, strengths, PI/DISC-ish)
    writing_style_md text,      -- 03-writing-style.md      (tone, structure, do/don't)
    evaluation_md text,         -- 04-job-evaluation.md     (career goals, deal-breakers, filters)
    cv_template_latex text,     -- 05-cv-templates.md       (LaTeX CV with [PLACEHOLDER] tokens)
    cover_template_latex text,  -- 06-cover-letter-templates.md
    interview_prep_md text,     -- 07-interview-prep.md     (STAR examples)
    search_queries text,        -- search-queries.md as JSON {keywords[], locations[]}
    setup_log text,             -- what /setup ingested, so re-runs are idempotent
    updated_at timestamptz not null default now()
);

-- /scrape results — the repo's job_scraper/ seen-store + job_search_tracker.csv.
create table if not exists engine_job (
    id uuid primary key,
    user_id uuid not null,
    source text not null default 'linkedin',
    external_id text,
    url text,
    title text,
    company text,
    location text,
    posted_at text,             -- as shown by the portal ("2 days ago" / ISO date)
    description text,           -- fetched lazily for rank/apply
    scraped_at timestamptz not null default now(),
    -- /rank output
    status text not null default 'new',   -- new | ranked | shortlisted | applying | applied
                                          -- | dismissed | expired
    fit_score int,
    verdict text,                          -- strong | good | moderate | weak | poor
    strengths text,
    gaps text,
    deal_breaker text,                     -- non-null = vetoed, with the reason
    urgent boolean not null default false, -- deadline flag
    rank_notes text,
    content_hash text not null,            -- dedup: sha256(title|company|location)
    constraint uq_engine_job unique (user_id, content_hash)
);
create index if not exists idx_engine_job_status on engine_job (user_id, status, fit_score desc);
create index if not exists idx_engine_job_scraped on engine_job (user_id, scraped_at desc);

-- /apply runs — the drafter→reviewer→revise→compile→ATS-verify pipeline with every
-- artifact archived (the repo's documents/applications/<company>_<role>/ folder).
create table if not exists engine_application (
    id uuid primary key,
    user_id uuid not null,
    job_id uuid,                 -- engine_job source, when applied from /scrape results
    posting_url text,
    posting_title text,
    posting_company text,
    posting_text text,           -- the parsed posting
    stage text not null default 'parsing',
        -- parsing | evaluating | drafting | reviewing | revising | compiling
        -- | verifying | ready | submitted | failed | vetoed
    stage_log text,              -- JSON [{stage, at, note}]
    evaluation text,             -- JSON: 5-dimension fit + keywords + recommendation
    fit_score int,
    verdict text,
    cv_latex text,
    cover_latex text,
    reviewer_feedback text,
    revision_notes text,
    cut_report text,             -- relevance-weighted CV cutting decisions (2-page rule)
    ats_report text,             -- JSON: text-layer + keyword coverage + honesty gaps
    cv_pdf bytea,
    cover_pdf bytea,
    cv_pages int,
    cover_pages int,
    error text,
    -- /outcome
    outcome text,                -- applied | interview_1 | interview_2 | offer | rejected | withdrawn
    outcome_notes text,
    outcome_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_engine_app_user on engine_application (user_id, updated_at desc);
create index if not exists idx_engine_app_stage on engine_application (user_id, stage);

-- /interview — stage-specific prep packs built from the application's own archive.
create table if not exists engine_interview (
    id uuid primary key,
    user_id uuid not null,
    application_id uuid references engine_application(id) on delete cascade,
    stage_label text not null,   -- "first interview", "technical round", ...
    pack_md text,
    created_at timestamptz not null default now()
);
create index if not exists idx_engine_interview_user on engine_interview (user_id, created_at desc);

-- /upskill — gap-analysis reports (skill heatmap + learning plan).
create table if not exists engine_upskill (
    id uuid primary key,
    user_id uuid not null,
    heatmap text,                -- JSON [{skill, demand, have}]
    report_md text,
    created_at timestamptz not null default now()
);
create index if not exists idx_engine_upskill_user on engine_upskill (user_id, created_at desc);
