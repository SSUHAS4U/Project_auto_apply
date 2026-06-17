-- Expand the owner profile to cover what real job applications actually ask for.
alter table profile
    add column first_name          text,
    add column last_name           text,
    add column headline            text,          -- e.g. "Backend Engineer"
    add column summary             text,          -- professional summary
    add column address             text,
    add column city                text,
    add column state               text,
    add column country             text,
    add column postal_code         text,
    add column date_of_birth       text,
    add column gender              text,
    add column nationality         text,

    add column current_title       text,
    add column current_company     text,
    add column years_experience    text,          -- free text e.g. "3.5"
    add column current_ctc         text,
    add column expected_ctc        text,
    add column notice_period       text,
    add column available_from      text,
    add column work_authorization  text,          -- e.g. "Indian citizen", "H1B"
    add column requires_sponsorship boolean,
    add column willing_to_relocate  boolean,
    add column preferred_locations  text[] default '{}',
    add column languages            text[] default '{}',

    add column education            jsonb default '[]'::jsonb,   -- [{school,degree,field,year}]
    add column certifications       jsonb default '[]'::jsonb,   -- [{name,issuer,year}]
    add column cover_letter_template text;        -- optional custom template/notes
