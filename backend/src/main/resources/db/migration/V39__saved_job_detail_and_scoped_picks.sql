-- 1. Saved listings carry enough to render the SAME card as the job board.
--
--    A saved job stored title/company/location and nothing else, because the extension sent
--    `raw: null` on every capture. That is why the Saved page needed its own bespoke card:
--    the shared one had no description to derive employment type, experience or skill matches
--    from, and no score to show a fit panel. Both columns exist so one card can serve every
--    job surface in the app.
--
--    Nullable on purpose. Listings captured before this migration have no description and
--    never will — the page they came from is gone. The card degrades for those rows rather
--    than printing "Not mentioned" four times, so old saves stay readable.
alter table saved_job add column if not exists description text;
alter table saved_job add column if not exists match_score int;

-- 2. Daily picks belong to a user, like every other surface in the app.
--
--    daily_pick was global: one set of rows, no owner. That was survivable only because
--    nothing ever READ the table — /api/daily/picks ignored it and re-ran a board query, so
--    the missing scope never showed. Now that the endpoint serves these rows, an unscoped
--    table would hand one account another account's curation.
alter table daily_pick add column if not exists user_id uuid references app_user(id) on delete cascade;

-- Existing rows belong to no one and cannot be attributed after the fact. They are stale by
-- definition (the set is replaced on every run), so drop them rather than guess an owner.
delete from daily_pick where user_id is null;

create index if not exists idx_daily_pick_user on daily_pick (user_id, rank);
