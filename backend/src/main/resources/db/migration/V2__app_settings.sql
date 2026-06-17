-- Simple key/value store for app-level watermarks (digest cutoff, last visit).
create table app_setting (
    key        text primary key,
    value      text,
    updated_at timestamptz default now()
);

insert into app_setting (key, value) values
    ('last_digest_at', null),
    ('last_visit_at',  null);
