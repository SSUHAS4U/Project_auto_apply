-- Fields Indian application forms actually ask for: shift willingness, competitive-coding
-- profiles + scores, and machine configuration. Marksheets go in the encrypted document
-- vault (user_doc), not here.
ALTER TABLE profile ADD COLUMN IF NOT EXISTS open_to_shifts   VARCHAR(16);
ALTER TABLE profile ADD COLUMN IF NOT EXISTS leetcode_url     VARCHAR(300);
ALTER TABLE profile ADD COLUMN IF NOT EXISTS leetcode_score   VARCHAR(40);
ALTER TABLE profile ADD COLUMN IF NOT EXISTS codechef_url     VARCHAR(300);
ALTER TABLE profile ADD COLUMN IF NOT EXISTS codechef_score   VARCHAR(40);
ALTER TABLE profile ADD COLUMN IF NOT EXISTS codeforces_url   VARCHAR(300);
ALTER TABLE profile ADD COLUMN IF NOT EXISTS codeforces_score VARCHAR(40);
ALTER TABLE profile ADD COLUMN IF NOT EXISTS laptop_config    VARCHAR(400);
