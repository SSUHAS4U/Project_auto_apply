-- Multi-touch follow-up. Until now a contact got an invite, one follow-up after acceptance,
-- and then the conversation died — no staged cadence, no archive rule, no re-engagement.
--
-- stage is the number of touches SENT: 0 = invited only, 1..4 = follow-ups sent, 5 = archived.
-- The schedule is Day 1, 2, 5, 10 after the previous touch, then stop.
alter table portal_contact add column if not exists follow_up_stage  int not null default 0;
alter table portal_contact add column if not exists last_contact_at  timestamptz;
alter table portal_contact add column if not exists archived_at      timestamptz;

-- Existing contacts that have already been messaged count as one touch, so the cadence picks
-- up from where they actually are instead of restarting them at Day 1.
update portal_contact
   set follow_up_stage = 1,
       last_contact_at = last_message_at
 where last_message_at is not null
   and follow_up_stage = 0;

-- Anything invited but never messaged starts the clock from when we last touched the record.
update portal_contact
   set last_contact_at = updated_at
 where last_contact_at is null
   and connection_status in ('pending', 'connected');

-- The due-follow-up query: "connected, not archived, last touched before X".
create index if not exists ix_contact_followup
    on portal_contact (user_id, connection_status, follow_up_stage, last_contact_at);
