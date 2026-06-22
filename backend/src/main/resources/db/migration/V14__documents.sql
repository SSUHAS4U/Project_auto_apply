-- Per-user document vault. Bytes are AES-GCM encrypted at rest (the column never holds
-- plaintext) and download requires re-entering the account password.
CREATE TABLE document (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID REFERENCES app_user(id) ON DELETE CASCADE,
    name         VARCHAR(255) NOT NULL,
    doc_type     VARCHAR(40)  NOT NULL DEFAULT 'other',
    filename     VARCHAR(255),
    content_type VARCHAR(160),
    size_bytes   BIGINT,
    data         BYTEA NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_document_user ON document (user_id);
