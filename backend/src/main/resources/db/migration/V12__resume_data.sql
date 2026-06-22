-- Store the resume bytes in the DB so it survives Render restarts (the local disk
-- is ephemeral — uploaded files vanish on redeploy/sleep, causing "no resume on file").
ALTER TABLE profile ADD COLUMN resume_data BYTEA;
