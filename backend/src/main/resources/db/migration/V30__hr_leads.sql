-- HR-lead pipeline: the worker scans LinkedIn posts for hiring emails; leads land as
-- contacts (email column), and the engine can auto-send a tailored application to the
-- lead's address the moment its package is ready.
ALTER TABLE portal_contact    ADD COLUMN IF NOT EXISTS email VARCHAR(200);
ALTER TABLE engine_application ADD COLUMN IF NOT EXISTS auto_send_to VARCHAR(200);
