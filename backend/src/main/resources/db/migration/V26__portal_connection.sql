-- Portal connections — the VS-Code-style "Connect" UX. For LinkedIn/Naukri/Indeed the
-- connection IS the persistent logged-in browser session on the owner's PC (cookies never
-- leave their machine — more secure than storing OAuth tokens server-side). This table
-- only tracks connection STATUS + a pending connect/disconnect action the worker consumes.
create table if not exists portal_connection (
    id uuid primary key,
    user_id uuid not null,
    portal text not null,                    -- linkedin | naukri | indeed
    status text not null default 'disconnected',  -- connected | connecting | disconnected
    requested_action text,                   -- connect | disconnect (worker consumes + clears)
    detail text,
    updated_at timestamptz not null default now(),
    constraint uq_portal_connection unique (user_id, portal)
);
create index if not exists idx_portal_connection_user on portal_connection (user_id);
