-- Which portal a screening question came from.
--
-- The LinkedIn and Indeed pages each show "their" questions, but every QA pair looked identical
-- — so both pages listed the same rows and neither was telling the truth. Existing rows keep a
-- null portal and show on both pages, which is honest: we genuinely don't know where they came
-- from, and hiding them would be worse than showing them twice.
alter table qa_pair add column if not exists portal varchar(32);

create index if not exists ix_qa_pair_portal on qa_pair (user_id, portal);
