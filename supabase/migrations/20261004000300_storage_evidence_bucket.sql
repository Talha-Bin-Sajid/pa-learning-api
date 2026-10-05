-- =====================================================================
-- Private storage bucket for completion evidence.
-- Files are uploaded and read only by the Node API (service role);
-- viewers get short-lived signed URLs. No storage policies are created,
-- so browser clients cannot list, read or write objects directly.
-- Guarded so the migration is a no-op on plain Postgres (tests).
-- =====================================================================
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('evidence', 'evidence', false, 15728640,
            array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
    on conflict (id) do nothing;
  end if;
end;
$$;
