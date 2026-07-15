-- Persist the Setup form's guided inputs verbatim so the fields round-trip on reload
-- (target roles, locations, career goal, deal-breakers, biggest wins). Previously only the
-- derived docs were stored, so career-goal/deal-breakers/wins came back blank after a refresh.
alter table engine_profile add column if not exists guided_inputs text;
