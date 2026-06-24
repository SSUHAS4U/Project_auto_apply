-- Encrypted API keys / secrets managed from the Admin UI. The value is AES-256-GCM
-- encrypted at rest (same scheme as the document vault); plaintext is never stored or returned.
CREATE TABLE IF NOT EXISTS app_secret (
    name       TEXT PRIMARY KEY,
    value_enc  TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
