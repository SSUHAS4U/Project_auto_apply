-- College/University name as a first-class field so autofill can answer it directly.
ALTER TABLE profile ADD COLUMN college VARCHAR(255);
