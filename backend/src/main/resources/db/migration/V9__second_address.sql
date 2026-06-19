-- Second/permanent address block (current address already uses city/state/country/postal_code).
alter table profile
    add column address2     text,
    add column city2        text,
    add column state2       text,
    add column country2     text,
    add column postal_code2 text;
