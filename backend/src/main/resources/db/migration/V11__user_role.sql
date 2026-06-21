-- Server-side role for authorization. Admin status lives in the DB (never trusted
-- from a token), so a leaked/forged token can't escalate to admin.
ALTER TABLE app_user ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'USER';

-- Seed the owner as admin.
UPDATE app_user SET role = 'ADMIN' WHERE lower(email) = 'ssuhas4u@gmail.com';
