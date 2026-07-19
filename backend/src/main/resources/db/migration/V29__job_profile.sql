-- Job Profile: what the candidate is hunting for + showcase material (projects,
-- achievements). Desired titles feed the automation's search keywords.
ALTER TABLE profile ADD COLUMN IF NOT EXISTS desired_titles   VARCHAR(500);
ALTER TABLE profile ADD COLUMN IF NOT EXISTS experience_level VARCHAR(40);
ALTER TABLE profile ADD COLUMN IF NOT EXISTS job_type         VARCHAR(40);
ALTER TABLE profile ADD COLUMN IF NOT EXISTS projects         JSONB DEFAULT '[]'::jsonb;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS achievements     JSONB DEFAULT '[]'::jsonb;
