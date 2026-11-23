-- 1. ONE resume library.
--
--    There were three places a résumé could live: profile.resume_data (a single upload),
--    resume_doc (the LaTeX builder) and the document vault. The owner uploads several résumés,
--    each aimed at a role, and wants the ones built in the builder to show up next to them and
--    be pickable when sending. resume_doc becomes that library: a builder résumé is a row with
--    LaTeX; an uploaded résumé is a row with the file in `pdf` and no LaTeX.
alter table resume_doc add column if not exists role varchar(120);
--    'built' (LaTeX, compiled on demand) or 'uploaded' (a file used as-is, never compiled).
alter table resume_doc add column if not exists source varchar(16) not null default 'built';
alter table resume_doc add column if not exists filename varchar(255);
--    Uploaded files can be DOCX as well as PDF; built ones are always application/pdf.
alter table resume_doc add column if not exists content_type varchar(120);
--    The one copied into profile.resume_data — what the worker and the extension attach when
--    nothing more specific is chosen. At most one per user (enforced in ResumeDocService).
alter table resume_doc add column if not exists is_default boolean not null default false;

-- 2. What was sent, to whom, by which channel — the History page.
--
--    Not outreach_log: that table is the auto-apply agent's anti-spam ledger. Its unique
--    (user, hash) key would REFUSE a legitimate second email to the same company, it
--    lower-cases company names for comparison, and it stores no message. This one is a record
--    for a person to read, so it keeps the exact text that went out.
create table if not exists sent_message (
    id            uuid primary key,
    user_id       uuid        not null references app_user(id) on delete cascade,
    channel       varchar(16) not null,          -- EMAIL | WHATSAPP
    status        varchar(16) not null,          -- SENT | FAILED | OPENED (handed to WhatsApp)
    company       varchar(255),
    role_title    varchar(255),
    recipient     varchar(255) not null,         -- an email address or an E.164 number (digits)
    subject       varchar(500),
    body          text,
    cover_letter  text,
    resume_name   varchar(255),                  -- which résumé went with it, as the user named it
    cover_attached  boolean not null default false,
    resume_attached boolean not null default false,
    error         text,
    created_at    timestamptz not null default now()
);
create index if not exists ix_sent_message_user on sent_message (user_id, created_at desc);

-- 3. Links to a résumé / cover letter that a WhatsApp message carries.
--
--    WhatsApp's click-to-chat URL can carry text but not files, so the message carries links.
--    The token is 256 bits of randomness — the link is the credential, as with any share link —
--    and expires. The résumé is served from the library row at request time (no copy of the
--    bytes); the cover letter's TEXT is kept and rendered to PDF when opened.
create table if not exists shared_doc (
    token         varchar(64) primary key,
    user_id       uuid        not null references app_user(id) on delete cascade,
    kind          varchar(16) not null,          -- RESUME | COVER
    resume_doc_id uuid references resume_doc(id) on delete cascade,
    cover_text    text,
    created_at    timestamptz not null default now(),
    expires_at    timestamptz not null
);
create index if not exists ix_shared_doc_user on shared_doc (user_id);

-- 4. The number the owner sends WhatsApp messages from.
alter table profile add column if not exists whatsapp_number varchar(32);
