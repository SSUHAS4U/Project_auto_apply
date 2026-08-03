-- Every outreach attempt, so the automation cannot contact the same person twice or bombard
-- one company in a single run. Before this table there were no limits at all beyond LinkedIn's
-- own weekly invite cap, and nothing stopped the same recruiter being messaged again on the
-- next run for the same role.
create table if not exists outreach_log (
    id             uuid primary key,
    user_id        uuid        not null,
    portal         varchar(32) not null,
    -- Lower-cased for comparison; the display forms live on portal_contact.
    company        varchar(255),
    role_title     varchar(255),
    recruiter_url  varchar(512),
    recruiter_name varchar(255),
    -- hash(company + role + recruiter + resume version): the idempotency key. A repeat of the
    -- exact same outreach is a duplicate; the same recruiter for a DIFFERENT role is not.
    outreach_hash  varchar(64) not null,
    created_at     timestamptz not null default now()
);

-- The idempotency check: one row per (user, hash). A duplicate insert fails loudly rather than
-- silently double-messaging someone.
create unique index if not exists ux_outreach_log_user_hash
    on outreach_log (user_id, outreach_hash);

-- The throttle queries: "how many for this company today", "when did we last touch this
-- recruiter", "how many in total today".
create index if not exists ix_outreach_log_company
    on outreach_log (user_id, company, created_at desc);
create index if not exists ix_outreach_log_recruiter
    on outreach_log (user_id, recruiter_url, created_at desc);
create index if not exists ix_outreach_log_created
    on outreach_log (user_id, created_at desc);
