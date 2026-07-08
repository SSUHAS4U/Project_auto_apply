-- What the AI changed (and why) when tailoring a resume copy to a JD.
alter table resume_doc add column if not exists tailor_notes text;
