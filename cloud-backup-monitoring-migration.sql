-- Monitoring records for the PC-independent OneDrive backup workflow.
-- Run after audit-backup-restore-migration.sql.

begin;

create table if not exists public.external_backup_runs (
  id bigint generated always as identity primary key,
  execution_key text not null unique,
  status text not null check (status in ('running','complete','failed')),
  storage_provider text not null default 'onedrive',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  file_name text,
  folder_path text,
  file_size_bytes bigint,
  sha256 text,
  table_count integer,
  row_count bigint,
  workflow_url text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_external_backup_runs_started_at
  on public.external_backup_runs(started_at desc);

alter table public.external_backup_runs enable row level security;
revoke all on public.external_backup_runs from anon, authenticated;
grant select on public.external_backup_runs to authenticated;
grant all on public.external_backup_runs to service_role;
grant usage, select on sequence public.external_backup_runs_id_seq to service_role;

drop policy if exists "admins read external backup runs" on public.external_backup_runs;
create policy "admins read external backup runs"
on public.external_backup_runs for select to authenticated
using (public.is_master_admin());

comment on table public.external_backup_runs is
  'Success and failure records for encrypted business-data exports sent directly to OneDrive by GitHub Actions.';

notify pgrst, 'reload schema';

commit;
