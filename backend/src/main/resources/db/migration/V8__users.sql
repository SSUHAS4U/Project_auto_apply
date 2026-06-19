-- Multi-user: accounts + per-user ownership of profile/applications/saved/notifications.
-- Jobs stay global (shared catalogue); users see them filtered by their own preferences.
create table app_user (
    id            uuid primary key default gen_random_uuid(),
    email         text not null unique,
    password_hash text not null,
    full_name     text,
    created_at    timestamptz default now()
);

alter table profile      add column user_id uuid references app_user(id) on delete cascade;
alter table application  add column user_id uuid references app_user(id) on delete cascade;
alter table saved_job    add column user_id uuid references app_user(id) on delete cascade;
alter table notification add column user_id uuid references app_user(id) on delete cascade;

create index idx_profile_user      on profile (user_id);
create index idx_application_user  on application (user_id);
create index idx_saved_job_user    on saved_job (user_id);
create index idx_notification_user on notification (user_id);
