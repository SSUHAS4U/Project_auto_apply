-- Region split for the Jobs board (india | outside | remote | unknown).
alter table job add column region text;
create index idx_job_region on job (region);

-- Secondary location on the profile (e.g. current city vs. home/preferred city).
alter table profile add column location2 text;

-- Reusable email template the AI rewrites per company (cover_letter_template exists from V3).
alter table profile add column email_template text;
