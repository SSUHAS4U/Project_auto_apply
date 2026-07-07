-- Health + discovery metadata for ATS boards, so the daily discovery job can
-- add fresh boards and retire dead ones automatically.
alter table ats_source add column if not exists last_checked_at timestamptz;
alter table ats_source add column if not exists last_job_count int;
alter table ats_source add column if not exists fail_count int not null default 0;
alter table ats_source add column if not exists discovered_via text;
