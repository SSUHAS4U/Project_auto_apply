-- Curated Greenhouse boards to poll on every ingest.
insert into ats_source (provider, board_token, company, active) values
    ('greenhouse', 'stripe',     'Stripe',     true),
    ('greenhouse', 'databricks', 'Databricks', true),
    ('greenhouse', 'notion',     'Notion',     true)
on conflict (provider, board_token)
    do update set active = true, company = excluded.company;
