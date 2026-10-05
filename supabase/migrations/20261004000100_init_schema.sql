-- =====================================================================
-- Project Accountants Learning Platform - initial schema
-- See docs/IMPLEMENTATION_PLAN.md §5 for the ERD and business rules.
--
-- Access model: the Node API is the only client of these tables.
-- RLS is enabled on every table with NO policies, so Supabase's anon /
-- authenticated keys (PostgREST) cannot read or write anything.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type user_role         as enum ('learning_team', 'hr', 'manager', 'team_member');
create type reporting_access  as enum ('full', 'self');
create type profile_status    as enum ('active', 'pending', 'inactive');
create type evidence_mode     as enum ('certificate', 'acknowledgement');
create type review_status     as enum ('not_reviewed', 'verified', 'flagged', 'rejected');
create type overdue_frequency as enum ('daily', 'weekly', 'fortnightly');
create type cc_policy         as enum ('never', 'overdue', 'always');
create type reminder_kind     as enum ('automatic', 'manual');
create type delivery_status   as enum ('sent', 'failed');

-- ---------------------------------------------------------------------
-- updated_at maintenance (pure bookkeeping, no business logic)
-- ---------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Lookup tables
-- ---------------------------------------------------------------------
create table designations (
  id                 smallint generated always as identity primary key,
  name               text     not null unique check (char_length(name) between 1 and 80),
  rank               smallint not null unique,
  grants_full_access boolean  not null default false,
  is_active          boolean  not null default true,
  created_at         timestamptz not null default now()
);

create table categories (
  id         smallint generated always as identity primary key,
  name       text     not null unique check (char_length(name) between 1 and 80),
  sort_order smallint not null default 0,
  is_active  boolean  not null default true,
  created_at timestamptz not null default now()
);

create table cpd_types (
  id         smallint generated always as identity primary key,
  name       text     not null unique check (char_length(name) between 1 and 80),
  sort_order smallint not null default 0,
  is_active  boolean  not null default true,
  created_at timestamptz not null default now()
);

create table delivery_types (
  id         smallint generated always as identity primary key,
  name       text     not null unique check (char_length(name) between 1 and 80),
  sort_order smallint not null default 0,
  is_active  boolean  not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------
create table profiles (
  id               uuid primary key default gen_random_uuid(),
  -- Supabase auth.users id. Nullable: the Learning Team can provision a
  -- person before they first sign in; the account is linked by email.
  auth_user_id     uuid unique,
  full_name        text not null check (char_length(btrim(full_name)) between 1 and 120),
  email            text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254),
  role             user_role        not null default 'team_member',
  designation_id   smallint references designations (id) on delete set null,
  reporting_access reporting_access not null default 'self',
  line_manager_id  uuid references profiles (id) on delete set null,
  status           profile_status   not null default 'active',
  avatar_color     text check (avatar_color is null or avatar_color ~ '^#[0-9a-fA-F]{6}$'),
  last_seen_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint profiles_not_own_manager check (line_manager_id is null or line_manager_id <> id)
);

create unique index profiles_email_lower_key on profiles (lower(email));
create index profiles_line_manager_idx on profiles (line_manager_id);
create index profiles_designation_idx  on profiles (designation_id);
create index profiles_role_idx         on profiles (role);
create index profiles_status_idx       on profiles (status);

create trigger profiles_set_updated_at before update on profiles
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- Learning cycles (programme years)
-- ---------------------------------------------------------------------
create table learning_cycles (
  id         uuid primary key default gen_random_uuid(),
  year       smallint not null unique check (year between 2000 and 2100),
  name       text     not null check (char_length(name) between 1 and 60),
  starts_on  date     not null,
  ends_on    date     not null,
  is_current boolean  not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint learning_cycles_dates check (ends_on > starts_on)
);

-- At most one current cycle.
create unique index learning_cycles_one_current on learning_cycles (is_current) where is_current;

create trigger learning_cycles_set_updated_at before update on learning_cycles
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- Learning items (the Learning Template of a cycle)
-- ---------------------------------------------------------------------
create table learning_items (
  id               uuid primary key default gen_random_uuid(),
  cycle_id         uuid     not null references learning_cycles (id) on delete restrict,
  title            text     not null check (char_length(btrim(title)) between 1 and 200),
  category_id      smallint not null references categories (id),
  cpd_type_id      smallint not null references cpd_types (id),
  delivery_type_id smallint not null references delivery_types (id),
  provider         text     not null default 'Internal' check (char_length(provider) between 1 and 120),
  hours            numeric(5, 2) not null check (hours > 0 and hours <= 500),
  due_date         date,
  is_mandatory     boolean  not null default false,
  evidence_mode    evidence_mode not null default 'certificate',
  link             text check (link is null or (link ~* '^https?://' and char_length(link) <= 2048)),
  description      text check (description is null or char_length(description) <= 2000),
  assign_to_all    boolean  not null default true,
  created_by       uuid references profiles (id) on delete set null,
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index learning_items_active_cycle_idx on learning_items (cycle_id) where archived_at is null;
create index learning_items_category_idx     on learning_items (category_id);

create trigger learning_items_set_updated_at before update on learning_items
  for each row execute function set_updated_at();

-- Audience: designations
create table learning_item_designations (
  item_id        uuid     not null references learning_items (id) on delete cascade,
  designation_id smallint not null references designations (id) on delete restrict,
  created_at     timestamptz not null default now(),
  primary key (item_id, designation_id)
);
create index learning_item_designations_designation_idx on learning_item_designations (designation_id);

-- Audience: named people
create table learning_item_profiles (
  item_id    uuid not null references learning_items (id) on delete cascade,
  profile_id uuid not null references profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (item_id, profile_id)
);
create index learning_item_profiles_profile_idx on learning_item_profiles (profile_id);

-- ---------------------------------------------------------------------
-- Completions (+ evidence and future review fields)
-- ---------------------------------------------------------------------
create table completions (
  id                  uuid primary key default gen_random_uuid(),
  profile_id          uuid not null references profiles (id) on delete cascade,
  item_id             uuid not null references learning_items (id) on delete restrict,
  completed_on        date not null,
  reflection          text check (reflection is null or char_length(reflection) <= 2000),
  evidence_path       text,
  evidence_file_name  text check (evidence_file_name is null or char_length(evidence_file_name) <= 255),
  evidence_mime_type  text,
  evidence_size_bytes integer check (evidence_size_bytes is null or (evidence_size_bytes > 0 and evidence_size_bytes <= 15728640)),
  review_status       review_status not null default 'not_reviewed',
  review_source       text check (review_source is null or review_source in ('ai', 'manual')),
  review_notes        text check (review_notes is null or char_length(review_notes) <= 2000),
  reviewed_by         uuid references profiles (id) on delete set null,
  reviewed_at         timestamptz,
  submitted_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint completions_one_per_person_item unique (profile_id, item_id),
  constraint completions_evidence_consistent check (
    (evidence_path is null and evidence_file_name is null and evidence_mime_type is null and evidence_size_bytes is null)
    or
    (evidence_path is not null and evidence_file_name is not null and evidence_mime_type is not null and evidence_size_bytes is not null)
  )
);

create index completions_item_idx         on completions (item_id);
create index completions_completed_on_idx on completions (completed_on);

create trigger completions_set_updated_at before update on completions
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- Reminders
-- ---------------------------------------------------------------------
create table reminder_settings (
  id                smallint primary key default 1 check (id = 1),
  auto_enabled      boolean           not null default true,
  lead_days         smallint[]        not null default '{30,14,7}',
  overdue_frequency overdue_frequency not null default 'weekly',
  send_time         time              not null default '09:00',
  timezone          text              not null default 'Europe/London',
  cc_line_manager   cc_policy         not null default 'overdue',
  updated_by        uuid references profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint reminder_settings_lead_days_valid check (
    cardinality(lead_days) between 0 and 10 and 0 < all (lead_days) and 366 > all (lead_days)
  )
);

create trigger reminder_settings_set_updated_at before update on reminder_settings
  for each row execute function set_updated_at();

insert into reminder_settings (id) values (1);

create table reminder_log (
  id                uuid primary key default gen_random_uuid(),
  recipient_id      uuid not null references profiles (id) on delete cascade,
  kind              reminder_kind   not null,
  run_date          date            not null,
  outstanding_count integer not null default 0 check (outstanding_count >= 0),
  overdue_count     integer not null default 0 check (overdue_count >= 0),
  triggers          text[]  not null default '{}',
  message           text check (message is null or char_length(message) <= 2000),
  cc_emails         text[]  not null default '{}',
  sent_by           uuid references profiles (id) on delete set null,
  delivery_status   delivery_status not null,
  error             text,
  sent_at           timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

-- The scheduler can never send two automatic reminders to one person on one day.
create unique index reminder_log_one_auto_per_day on reminder_log (recipient_id, run_date) where kind = 'automatic';
create index reminder_log_sent_at_idx on reminder_log (sent_at desc);

-- ---------------------------------------------------------------------
-- Audit trail for admin actions
-- ---------------------------------------------------------------------
create table audit_events (
  id          bigint generated always as identity primary key,
  actor_id    uuid references profiles (id) on delete set null,
  action      text not null check (char_length(action) between 1 and 80),
  entity_type text not null,
  entity_id   text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index audit_events_entity_idx  on audit_events (entity_type, entity_id);
create index audit_events_created_idx on audit_events (created_at desc);

-- ---------------------------------------------------------------------
-- Lock down PostgREST access: RLS on, no policies.
-- ---------------------------------------------------------------------
alter table designations               enable row level security;
alter table categories                 enable row level security;
alter table cpd_types                  enable row level security;
alter table delivery_types             enable row level security;
alter table profiles                   enable row level security;
alter table learning_cycles            enable row level security;
alter table learning_items             enable row level security;
alter table learning_item_designations enable row level security;
alter table learning_item_profiles     enable row level security;
alter table completions                enable row level security;
alter table reminder_settings          enable row level security;
alter table reminder_log               enable row level security;
alter table audit_events               enable row level security;

-- Belt and braces on Supabase: remove default grants to the API roles.
-- (Guarded so the migration also runs on plain Postgres, e.g. in tests.)
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
    execute 'revoke all on all functions in schema public from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on sequences from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on functions from anon, authenticated';
  end if;
end;
$$;
