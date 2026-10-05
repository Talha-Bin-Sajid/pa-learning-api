-- One-off notifications (e.g. the weekly "evidence waiting for review" digest).
-- A row per notification key; inserting the same key twice is a no-op, so a
-- restarted scheduler never sends the same digest twice.

create table if not exists notification_log (
  key text primary key check (char_length(key) between 1 and 200),
  sent_at timestamptz not null default now()
);

alter table notification_log enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on notification_log from anon, authenticated';
  end if;
end;
$$;
