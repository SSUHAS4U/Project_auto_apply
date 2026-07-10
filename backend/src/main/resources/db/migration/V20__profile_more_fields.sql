-- Personal fields Indian ATS forms routinely ask for.
alter table profile add column if not exists alternate_phone text;
alter table profile add column if not exists marital_status text;
alter table profile add column if not exists father_name text;
alter table profile add column if not exists disability_status text;
