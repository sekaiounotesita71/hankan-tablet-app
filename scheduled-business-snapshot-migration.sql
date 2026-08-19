-- Create one application-level business snapshot every day at 19:00 JST.
-- Supabase Postgres uses UTC, so 19:00 JST is scheduled as 10:00 UTC.
-- Run after audit-backup-restore-migration.sql.

begin;

create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.run_scheduled_business_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  snapshot_id uuid;
  target_table text;
  inserted_rows bigint;
  total_rows bigint := 0;
  completed_tables integer := 0;
  deleted_snapshots bigint := 0;
begin
  insert into public.audit_snapshots(label,created_by,created_by_email)
  values (
    '自動バックアップ ' || to_char(now() at time zone 'Asia/Tokyo','YYYY-MM-DD HH24:MI'),
    null,
    'scheduled-backup@system'
  )
  returning id into snapshot_id;

  foreach target_table in array array[
    'work_sessions','order_lines','boxes','sales_records',
    'order_entry_batches','order_entry_lines','pending_entries','historical_sales_records',
    'accounts_receivable','accounts_receivable_payments','accounts_receivable_statement_profiles','accounts_receivable_statements','accounts_receivable_closings',
    'external_work_assignments','external_work_assignment_lines','external_work_inputs',
    'purchase_receipts','purchase_receipt_lines','inventory_lots','inventory_allocations',
    'accounts_payable_supplier_profiles','accounts_payable','accounts_payable_payments',
    'importer_master','supplier_master','product_master','product_price_contracts','customer_master',
    'invoice_profiles','invoice_product_rules','invoice_export_logs',
    'product_guide_templates','product_guide_variants','product_guide_template_rows',
    'site_master','internal_user_access','partner_user_access','user_roles'
  ]
  loop
    if to_regclass(format('public.%I',target_table)) is null then
      continue;
    end if;

    execute format(
      'insert into public.audit_snapshot_rows(snapshot_id,schema_name,table_name,row_data) select $1,''public'',%L,to_jsonb(source_row) from public.%I source_row',
      target_table,
      target_table
    ) using snapshot_id;
    get diagnostics inserted_rows = row_count;
    total_rows := total_rows + inserted_rows;
    completed_tables := completed_tables + 1;
  end loop;

  update public.audit_snapshots
  set status = 'complete',
      table_count = completed_tables,
      row_count = total_rows,
      completed_at = now()
  where id = snapshot_id;

  -- Keep one month of application-level snapshots. Snapshot rows are removed
  -- automatically by the foreign key's ON DELETE CASCADE rule.
  delete from public.audit_snapshots
  where created_at < now() - interval '30 days';
  get diagnostics deleted_snapshots = row_count;

  return jsonb_build_object(
    'snapshot_id',snapshot_id,
    'table_count',completed_tables,
    'row_count',total_rows,
    'deleted_snapshots',deleted_snapshots,
    'retention_days',30,
    'status','complete'
  );
exception when others then
  if snapshot_id is not null then
    update public.audit_snapshots
    set status = 'failed',
        completed_at = now(),
        error_message = sqlerrm
    where id = snapshot_id;
  end if;
  raise;
end;
$$;

revoke all on function public.run_scheduled_business_snapshot() from public, anon, authenticated, service_role;
grant execute on function public.run_scheduled_business_snapshot() to postgres;

do $$
declare
  existing_job_id bigint;
begin
  select jobid
  into existing_job_id
  from cron.job
  where jobname = 'daily-business-snapshot-1900-jst'
  order by jobid desc
  limit 1;

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'daily-business-snapshot-1900-jst',
    '0 10 * * *',
    'select public.run_scheduled_business_snapshot();'
  );
end;
$$;

commit;

select
  jobid,
  jobname,
  schedule,
  command,
  active
from cron.job
where jobname = 'daily-business-snapshot-1900-jst';
