-- Optional job details captured on job_identified events, so the LinkedIn/Indeed cards can
-- show salary + a short description snippet (both blank when the portal didn't expose them).
ALTER TABLE agent_event ADD COLUMN IF NOT EXISTS salary      text;
ALTER TABLE agent_event ADD COLUMN IF NOT EXISTS description text;
