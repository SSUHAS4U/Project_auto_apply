-- Forms routinely split the name into three boxes (First / Middle / Last) while the profile
-- only ever stored a full name plus first/last. Middle name had nowhere to live, so those
-- boxes either got the wrong token or nothing at all.
ALTER TABLE profile ADD COLUMN IF NOT EXISTS middle_name VARCHAR(120);
