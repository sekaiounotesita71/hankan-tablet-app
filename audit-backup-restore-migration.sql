-- Business-wide audit log, guarded single-record restore, and manual snapshots.
-- Run once in Supabase SQL Editor after the existing application migrations.

begin;

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  schema_name text not null default 'public',
  table_name text not null,
  operation text not null check (operation in ('INSERT','UPDATE','DELETE')),
  record_pk jsonb not null default '{}'::jsonb,
  old_data jsonb,
  new_data jsonb,
  changed_by uuid,
  changed_by_email text,
  transaction_id bigint not null default txid_current(),
  change_source text not null default 'application',
  reason text,
  restored_from_event_id bigint references public.audit_events(id)
);

create index if not exists idx_audit_events_occurred_at
  on public.audit_events(occurred_at desc);
create index if not exists idx_audit_events_table_record
  on public.audit_events(table_name, record_pk, occurred_at desc);
create index if not exists idx_audit_events_changed_by
  on public.audit_events(changed_by, occurred_at desc);

comment on table public.audit_events is
  'Append-only audit trail for critical business tables. Direct client writes are prohibited.';

create table if not exists public.audit_snapshots (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  status text not null default 'creating' check (status in ('creating','complete','failed')),
  table_count integer not null default 0,
  row_count bigint not null default 0,
  created_by uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text
);

create table if not exists public.audit_snapshot_rows (
  id bigint generated always as identity primary key,
  snapshot_id uuid not null references public.audit_snapshots(id) on delete cascade,
  schema_name text not null default 'public',
  table_name text not null,
  row_data jsonb not null
);

create index if not exists idx_audit_snapshot_rows_snapshot_table
  on public.audit_snapshot_rows(snapshot_id, table_name);

alter table public.audit_events enable row level security;
alter table public.audit_snapshots enable row level security;
alter table public.audit_snapshot_rows enable row level security;

revoke all on public.audit_events from anon, authenticated;
revoke all on public.audit_snapshots from anon, authenticated;
revoke all on public.audit_snapshot_rows from anon, authenticated;

grant select on public.audit_events to authenticated;
grant select on public.audit_snapshots to authenticated;

drop policy if exists "admins read audit events" on public.audit_events;
create policy "admins read audit events"
on public.audit_events for select to authenticated
using (public.is_master_admin());

drop policy if exists "admins read audit snapshots" on public.audit_snapshots;
create policy "admins read audit snapshots"
on public.audit_snapshots for select to authenticated
using (public.is_master_admin());

drop policy if exists "admins read audit snapshot rows" on public.audit_snapshot_rows;
create policy "admins read audit snapshot rows"
on public.audit_snapshot_rows for select to authenticated
using (public.is_master_admin());

create or replace function public.log_business_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  old_payload jsonb;
  new_payload jsonb;
  primary_key jsonb;
  audit_source text;
  audit_reason text;
  restored_from bigint;
begin
  old_payload := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  new_payload := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;

  -- Ignore timestamp-only writes caused by touch_updated_at triggers.
  if tg_op = 'UPDATE'
     and (old_payload - 'updated_at') = (new_payload - 'updated_at') then
    return new;
  end if;

  select coalesce(
    jsonb_object_agg(attribute.attname, coalesce(new_payload -> attribute.attname, old_payload -> attribute.attname)),
    '{}'::jsonb
  )
  into primary_key
  from pg_index index_definition
  join lateral unnest(index_definition.indkey) with ordinality key_column(attnum, position) on true
  join pg_attribute attribute
    on attribute.attrelid = index_definition.indrelid
   and attribute.attnum = key_column.attnum
  where index_definition.indrelid = tg_relid
    and index_definition.indisprimary;

  audit_source := nullif(current_setting('app.audit_source', true),'');
  audit_reason := nullif(current_setting('app.audit_reason', true),'');
  begin
    restored_from := nullif(current_setting('app.audit_restored_from', true),'')::bigint;
  exception when others then
    restored_from := null;
  end;

  insert into public.audit_events (
    schema_name,
    table_name,
    operation,
    record_pk,
    old_data,
    new_data,
    changed_by,
    changed_by_email,
    change_source,
    reason,
    restored_from_event_id
  ) values (
    tg_table_schema,
    tg_table_name,
    tg_op,
    coalesce(primary_key,'{}'::jsonb),
    old_payload,
    new_payload,
    auth.uid(),
    nullif(auth.jwt() ->> 'email',''),
    coalesce(audit_source,'application'),
    audit_reason,
    restored_from
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.log_business_audit_event() from public;

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'work_sessions',
    'order_lines',
    'boxes',
    'sales_records',
    'order_entry_batches',
    'order_entry_lines',
    'pending_entries',
    'historical_sales_records',
    'accounts_receivable',
    'accounts_receivable_payments',
    'accounts_receivable_statement_profiles',
    'accounts_receivable_statements',
    'accounts_receivable_closings',
    'external_work_assignments',
    'external_work_assignment_lines',
    'external_work_inputs',
    'purchase_receipts',
    'purchase_receipt_lines',
    'inventory_lots',
    'inventory_allocations',
    'accounts_payable_supplier_profiles',
    'accounts_payable',
    'accounts_payable_payments',
    'importer_master',
    'supplier_master',
    'product_master',
    'product_price_contracts',
    'customer_master',
    'invoice_profiles',
    'invoice_product_rules',
    'invoice_export_logs',
    'product_guide_templates',
    'product_guide_variants',
    'product_guide_template_rows',
    'site_master',
    'internal_user_access',
    'partner_user_access',
    'user_roles'
  ]
  loop
    if to_regclass(format('public.%I',target_table)) is null then
      continue;
    end if;

    execute format('drop trigger if exists trg_business_audit on public.%I',target_table);
    execute format(
      'create trigger trg_business_audit after insert or update or delete on public.%I for each row execute function public.log_business_audit_event()',
      target_table
    );
  end loop;
end $$;

create or replace function public.restore_audit_event(
  p_audit_event_id bigint,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  event_row public.audit_events%rowtype;
  target_relation regclass;
  primary_key_columns text;
  insert_columns text;
  select_columns text;
  update_columns text;
  restore_sql text;
  target_payload jsonb;
  later_event_id bigint;
begin
  if not public.is_master_admin() then
    raise exception 'Only administrators can restore audit events.' using errcode = '42501';
  end if;

  if length(trim(coalesce(p_reason,''))) < 4 then
    raise exception 'A restore reason of at least 4 characters is required.' using errcode = '22023';
  end if;

  select * into event_row
  from public.audit_events
  where id = p_audit_event_id;

  if not found then
    raise exception 'Audit event % was not found.', p_audit_event_id using errcode = 'P0002';
  end if;

  if event_row.operation not in ('UPDATE','DELETE') or event_row.old_data is null then
    raise exception 'Only UPDATE and DELETE events can be restored.' using errcode = '22023';
  end if;

  target_relation := to_regclass(format('%I.%I',event_row.schema_name,event_row.table_name));
  if target_relation is null then
    raise exception 'Target table %.% no longer exists.', event_row.schema_name,event_row.table_name;
  end if;

  if event_row.record_pk = '{}'::jsonb then
    raise exception 'This event has no primary key and cannot be restored safely.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(event_row.schema_name || '.' || event_row.table_name || ':' || event_row.record_pk::text,0)
  );

  select id into later_event_id
  from public.audit_events
  where schema_name = event_row.schema_name
    and table_name = event_row.table_name
    and record_pk = event_row.record_pk
    and id > event_row.id
  order by id desc
  limit 1;

  if later_event_id is not null then
    raise exception 'A newer change (%) exists for this record. Restore the newest change first.', later_event_id;
  end if;

  select string_agg(format('%I',attribute.attname),', ' order by key_column.position)
  into primary_key_columns
  from pg_index index_definition
  join lateral unnest(index_definition.indkey) with ordinality key_column(attnum, position) on true
  join pg_attribute attribute
    on attribute.attrelid = index_definition.indrelid
   and attribute.attnum = key_column.attnum
  where index_definition.indrelid = target_relation
    and index_definition.indisprimary;

  if primary_key_columns is null then
    raise exception 'Target table %.% has no primary key.', event_row.schema_name,event_row.table_name;
  end if;

  select
    string_agg(format('%I',attribute.attname),', ' order by attribute.attnum),
    string_agg(format('restored.%I',attribute.attname),', ' order by attribute.attnum),
    string_agg(format('%1$I = excluded.%1$I',attribute.attname),', ' order by attribute.attnum)
      filter (where not (event_row.record_pk ? attribute.attname))
  into insert_columns, select_columns, update_columns
  from pg_attribute attribute
  where attribute.attrelid = target_relation
    and attribute.attnum > 0
    and not attribute.attisdropped
    and attribute.attgenerated = ''
    and attribute.attidentity <> 'a';

  target_payload := event_row.old_data;
  restore_sql := format(
    'insert into %I.%I (%s) select %s from jsonb_populate_record(null::%I.%I,$1) restored on conflict (%s) %s',
    event_row.schema_name,
    event_row.table_name,
    insert_columns,
    select_columns,
    event_row.schema_name,
    event_row.table_name,
    primary_key_columns,
    case when update_columns is null then 'do nothing' else 'do update set ' || update_columns end
  );

  perform set_config('app.audit_source','admin_restore',true);
  perform set_config('app.audit_reason',trim(p_reason),true);
  perform set_config('app.audit_restored_from',event_row.id::text,true);
  execute restore_sql using target_payload;

  return jsonb_build_object(
    'restored',true,
    'audit_event_id',event_row.id,
    'table_name',event_row.table_name,
    'record_pk',event_row.record_pk
  );
end;
$$;

revoke all on function public.restore_audit_event(bigint,text) from public;
grant execute on function public.restore_audit_event(bigint,text) to authenticated;

create or replace function public.create_business_snapshot(p_label text default null)
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
begin
  if not public.is_master_admin() then
    raise exception 'Only administrators can create snapshots.' using errcode = '42501';
  end if;

  insert into public.audit_snapshots(label,created_by,created_by_email)
  values (
    coalesce(nullif(trim(p_label),''),'手動バックアップ ' || to_char(now() at time zone 'Asia/Tokyo','YYYY-MM-DD HH24:MI')),
    auth.uid(),
    nullif(auth.jwt() ->> 'email','')
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

  return jsonb_build_object(
    'snapshot_id',snapshot_id,
    'table_count',completed_tables,
    'row_count',total_rows,
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

revoke all on function public.create_business_snapshot(text) from public;
grant execute on function public.create_business_snapshot(text) to authenticated;

notify pgrst, 'reload schema';

commit;
