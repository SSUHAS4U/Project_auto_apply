-- Autopilot: let the Engine run its whole cycle (scrape -> rank -> apply top-N) by
-- itself every day, like the ai-job-search workflow but unattended. Per-user config
-- lives on the engine_profile row; the daily scheduler runs every enabled profile.

alter table engine_profile add column if not exists auto_enabled boolean not null default false;
alter table engine_profile add column if not exists daily_cap int not null default 15;   -- max auto-applies/day (each ~5 AI calls)
alter table engine_profile add column if not exists min_fit int not null default 60;      -- only auto-apply at/above this fit
alter table engine_profile add column if not exists last_run_at timestamptz;
alter table engine_profile add column if not exists last_run_summary text;

create index if not exists idx_engine_profile_auto on engine_profile (auto_enabled);
