-- Saved application question→answer bank (per user). Lets the extension autofill
-- known free-text questions instantly and reuse AI-generated answers.
CREATE TABLE qa_pair (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID REFERENCES app_user(id) ON DELETE CASCADE,
    question     TEXT NOT NULL,
    question_key TEXT NOT NULL,          -- normalized question for matching
    answer       TEXT NOT NULL,
    source       VARCHAR(16) DEFAULT 'manual',  -- manual | ai
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_qa_user_key ON qa_pair (user_id, question_key);
CREATE INDEX ix_qa_user ON qa_pair (user_id);
