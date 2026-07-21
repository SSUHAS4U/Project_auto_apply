-- Extra Easy-Apply autofill answers commonly asked on LinkedIn/Indeed application forms.
-- All optional; blank/null just means "let the AI/custom answers handle it".
ALTER TABLE profile ADD COLUMN IF NOT EXISTS phone_country_code   text;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS willing_remote       boolean;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS willing_onsite       boolean;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS security_clearance   boolean;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS highest_education    text;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS gpa                  text;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS tier_one_institution boolean;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS completed_bachelors  boolean;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS ethnicity            text;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS veteran_status       text;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS hispanic_latino      boolean;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS how_did_you_hear     text;
-- Per-skill years of experience, e.g. {"java":"3","react":"1"}.
ALTER TABLE profile ADD COLUMN IF NOT EXISTS skills_experience    jsonb DEFAULT '{}'::jsonb;
