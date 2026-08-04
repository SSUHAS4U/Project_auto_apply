-- 1. Which flow produced an event, so the four LinkedIn automations can be counted separately
--    instead of all landing in one undifferentiated "LinkedIn activity" pile.
alter table agent_event add column if not exists flow varchar(32);
create index if not exists ix_agent_event_flow on agent_event (user_id, flow, created_at desc);

-- 2. Cross-channel person dedup.
--
--    The same recruiter turns up in several hiring posts: one post carries their email, another
--    only their profile. Without an address on the outreach log, emailing them from post A and
--    messaging them from post B looked like two different people — so they got both.
--
--    Recording the email alongside the profile URL lets ONE lookup answer "have we contacted
--    this person, by any means?".
alter table outreach_log add column if not exists email varchar(255);
alter table outreach_log add column if not exists channel varchar(16);

create index if not exists ix_outreach_log_email on outreach_log (user_id, email, created_at desc);
