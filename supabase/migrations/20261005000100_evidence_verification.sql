-- =====================================================================
-- AI evidence verification (docs: backend/docs/adr/0005-ai-evidence-verification.md)
--
-- evidence_checks is both the job queue (status queued → running → done/failed)
-- and the audit trail of every automated check. The final decision is written
-- to completions.review_status by the application's EvidencePolicy.
-- =====================================================================

create type evidence_check_status as enum ('queued', 'running', 'done', 'failed', 'superseded');

-- Fingerprint of the uploaded file, to catch the same certificate reused
-- for another item or by another person.
alter table completions add column evidence_sha256 text
  check (evidence_sha256 is null or evidence_sha256 ~ '^[0-9a-f]{64}$');
create index completions_evidence_sha256_idx on completions (evidence_sha256) where evidence_sha256 is not null;

create table evidence_checks (
  id              uuid primary key default gen_random_uuid(),
  completion_id   uuid not null references completions (id) on delete cascade,
  -- The exact file that was checked (a later re-upload gets a new check).
  evidence_path   text not null,
  status          evidence_check_status not null default 'queued',
  attempts        smallint not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  provider        text,
  model           text,
  -- Raw structured answer from the model (extracted fields + per-check results).
  analysis        jsonb,
  -- Outcome of the firm's policy applied to the analysis.
  decision        text check (decision is null or decision in ('verified', 'flagged')),
  reasons         text[] not null default '{}',
  confidence      numeric(4, 3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  input_tokens    integer check (input_tokens is null or input_tokens >= 0),
  output_tokens   integer check (output_tokens is null or output_tokens >= 0),
  error           text check (error is null or char_length(error) <= 1000),
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  constraint evidence_checks_done_has_decision check (status <> 'done' or decision is not null)
);

-- Worker picks the oldest due job.
create index evidence_checks_queue_idx on evidence_checks (next_attempt_at) where status = 'queued';
create index evidence_checks_completion_idx on evidence_checks (completion_id, created_at desc);

alter table evidence_checks enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on evidence_checks from anon, authenticated';
  end if;
end;
$$;
