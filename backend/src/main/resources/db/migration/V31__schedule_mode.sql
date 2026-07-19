-- Block mode: 'apply' (Easy Apply / Indeed Apply only) vs 'outreach' (post scan, HR
-- emails, connections — the once-a-day, longer slot). Lets the recommended plan run
-- Easy Apply twice a day per portal and outreach once, as the owner wants.
ALTER TABLE agent_schedule ADD COLUMN IF NOT EXISTS mode VARCHAR(20) DEFAULT 'apply';
