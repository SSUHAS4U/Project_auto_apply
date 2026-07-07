-- LaTeX resume builder: named, editable LaTeX resumes compiled to PDF.
-- One is the BASE (the original); per-JD tailored copies are duplicated from it.
create table if not exists resume_doc (
    id uuid primary key,
    user_id uuid not null,
    name text not null,
    latex text not null default '',
    pdf bytea,
    is_base boolean not null default false,
    job_url text,
    jd_text text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_resume_doc_user on resume_doc (user_id, updated_at desc);
