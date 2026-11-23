-- Delivery export metadata only; no financial changes or historical backfill.
-- Apply after order-entry-beta-migration.sql, site-partner-purchase-migration.sql,
-- sales-lock-trial-migration.sql, and domestic-intermediary-export-migration.sql.
-- Deployment requires a trusted owner able to update domestic_sale_lines.
-- The existing domestic touch/audit triggers remain enabled. Financial work,
-- payment and billing locks are neither consulted nor bypassed by this RPC.
--
-- RPC contract: authenticated internal users submit every current sale-line id
-- exactly once (1..5000), with its numeric expected_revision. Only the six keys
-- listed below are accepted. Missing metadata keys preserve the stored value;
-- explicit null/blank clears it. Limits are 120 characters for order/carton,
-- 300 for spec/customer. Each successful save increments every line revision,
-- including unchanged lines, and returns {sale_id, lines:[{id,
-- external_order_no, delivery_carton_no, delivery_spec, delivery_customer_name,
-- delivery_export_revision, delivery_metadata_saved, updated_at}]}.
-- Metadata keys are flat, not nested. delivery_metadata_saved is server-owned:
-- false allows source fallbacks; true means null metadata is explicitly blank.
-- A revision bump alone must never be used to infer this flag.
-- Reload on SQLSTATE 40001; do not silently retry a stale snapshot.
-- Apply delivery-export-correction-migration.sql after this migration and after
-- domestic-linked-sale-correction-migration.sql to preserve metadata/flags and
-- invalidate stale editors across financial correction delete/reinsert cycles.
-- Existing rows receive no copied external order number.
-- Absent/null source references leave an inserted number null; no name/row-order
-- fallback is attempted. Editing work/domestic metadata never writes upstream.

begin;

alter table public.order_entry_lines
  add column if not exists external_order_no text;
alter table public.order_lines
  add column if not exists external_order_no text;
alter table public.sales_records
  add column if not exists external_order_no text;
alter table public.domestic_sale_lines
  add column if not exists external_order_no text,
  add column if not exists delivery_carton_no text,
  add column if not exists delivery_spec text,
  add column if not exists delivery_customer_name text,
  add column if not exists delivery_export_revision integer not null default 0,
  add column if not exists delivery_metadata_saved boolean not null default false;

do $$
declare
  target_table text;
  constraint_name text;
begin
  foreach target_table in array array[
    'order_entry_lines', 'order_lines', 'sales_records', 'domestic_sale_lines'
  ] loop
    constraint_name := target_table || '_external_order_no_length_check';
    if not exists (
      select 1 from pg_catalog.pg_constraint
      where conname = constraint_name
        and conrelid = format('public.%I', target_table)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I check (char_length(external_order_no) <= 120)',
        target_table, constraint_name
      );
    end if;
  end loop;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'domestic_sale_lines_delivery_metadata_check'
      and conrelid = 'public.domestic_sale_lines'::regclass
  ) then
    alter table public.domestic_sale_lines
      add constraint domestic_sale_lines_delivery_metadata_check check (
        char_length(delivery_carton_no) <= 120
        and char_length(delivery_spec) <= 300
        and char_length(delivery_customer_name) <= 300
        and delivery_export_revision is not null
        and delivery_export_revision >= 0
      );
  end if;
end;
$$;

-- One-way insert snapshots only. Explicit values (even empty text) win.
-- Upsert clients send empty text for an intentional clear: BEFORE INSERT
-- also runs before conflict resolution, so null would inherit the source again.
-- Invoker rights preserve the source table's existing RLS/access restrictions.
create or replace function public.copy_delivery_external_order_no()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.external_order_no is not null then
    return new;
  end if;

  if tg_table_name = 'order_lines' then
    select source.external_order_no into new.external_order_no
    from public.order_entry_lines source
    where source.id = new.source_order_line_id;
  elsif tg_table_name = 'sales_records' then
    select source.external_order_no into new.external_order_no
    from public.order_lines source
    where source.session_id = new.session_id
      and source.source_row_no = new.source_row_no;
  elsif tg_table_name = 'domestic_sale_lines' then
    -- A saved null is an intentional clear, including on correction reinserts.
    if new.delivery_metadata_saved then
      return new;
    end if;
    select source.external_order_no into new.external_order_no
    from public.sales_records source
    where source.id = new.source_sales_record_id;
  end if;
  return new;
end;
$$;

revoke all on function public.copy_delivery_external_order_no()
  from public, anon, authenticated;

drop trigger if exists trg_delivery_external_order_no on public.order_lines;
create trigger trg_delivery_external_order_no
before insert on public.order_lines
for each row when (new.external_order_no is null)
execute function public.copy_delivery_external_order_no();

drop trigger if exists trg_delivery_external_order_no on public.sales_records;
create trigger trg_delivery_external_order_no
before insert on public.sales_records
for each row when (new.external_order_no is null)
execute function public.copy_delivery_external_order_no();

drop trigger if exists trg_delivery_external_order_no on public.domestic_sale_lines;
create trigger trg_delivery_external_order_no
before insert on public.domestic_sale_lines
for each row when (new.external_order_no is null)
execute function public.copy_delivery_external_order_no();

create or replace function public.save_domestic_delivery_metadata(
  p_sale_id uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
-- Domestic lines grant authenticated users SELECT only; do not add direct DML.
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  sale_status text;
  line_item jsonb;
  field_rule record;
  parsed_id uuid;
  requested_count integer;
  actual_count integer;
  saved_count integer;
  saved_lines jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_internal_user(), false) then
    raise exception 'Authenticated internal access is required.' using errcode = '42501';
  end if;
  if p_sale_id is null then
    raise exception 'A sale id is required.' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'Lines must be a JSON array.' using errcode = '22023';
  end if;
  requested_count := jsonb_array_length(p_lines);
  if requested_count < 1 or requested_count > 5000 then
    raise exception 'Submit between 1 and 5000 lines.' using errcode = '22023';
  end if;

  -- Validate shape and scalar types before casts, locks or any writes.
  for line_item in select value from jsonb_array_elements(p_lines)
  loop
    if jsonb_typeof(line_item) is distinct from 'object' then
      raise exception 'Each line must be a JSON object.' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_object_keys(line_item) as supplied(key)
      where key not in (
        'id', 'expected_revision', 'external_order_no', 'delivery_carton_no',
        'delivery_spec', 'delivery_customer_name'
      )
    ) then
      raise exception 'Unsupported line field.' using errcode = '22023';
    end if;
    if jsonb_typeof(line_item -> 'id') is distinct from 'string' then
      raise exception 'Each line requires a UUID id.' using errcode = '22023';
    end if;
    begin
      parsed_id := (line_item ->> 'id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Each line requires a UUID id.' using errcode = '22023';
    end;
    if jsonb_typeof(line_item -> 'expected_revision') is distinct from 'number' then
      raise exception 'Each line requires a numeric expected_revision.' using errcode = '22023';
    end if;
    if (line_item ->> 'expected_revision') !~ '^(0|[1-9][0-9]{0,9})$' then
      raise exception 'expected_revision must be a nonnegative integer.' using errcode = '22023';
    end if;
    if (line_item ->> 'expected_revision')::bigint > 2147483646 then
      raise exception 'Metadata revision is exhausted; reload and contact an administrator.'
        using errcode = '22023';
    end if;

    for field_rule in
      select * from (values
        ('external_order_no', 120), ('delivery_carton_no', 120),
        ('delivery_spec', 300), ('delivery_customer_name', 300)
      ) as limits(field_name, max_chars)
    loop
      if line_item ? field_rule.field_name then
        if jsonb_typeof(line_item -> field_rule.field_name) not in ('string', 'null') then
          raise exception '% must be text or null.', field_rule.field_name using errcode = '22023';
        end if;
        if char_length(line_item ->> field_rule.field_name) > field_rule.max_chars then
          raise exception '% exceeds % characters.', field_rule.field_name, field_rule.max_chars
            using errcode = '22023';
        end if;
      end if;
    end loop;
  end loop;

  -- Compare parsed UUIDs so differently formatted duplicates cannot pass.
  if (select count(distinct (value ->> 'id')::uuid)
      from jsonb_array_elements(p_lines)) <> requested_count then
    raise exception 'Duplicate line ids are not allowed.' using errcode = '22023';
  end if;

  -- Parent first matches correction/cancellation lock order and prevents new
  -- children via the existing sale_id FK; child locks stabilize all revisions.
  select s.status into sale_status
  from public.domestic_sales s
  where s.id = p_sale_id
  for update;
  if not found then
    raise exception 'Sale not found.' using errcode = 'P0002';
  end if;
  if sale_status is distinct from 'confirmed' then
    raise exception 'Only confirmed sales accept delivery metadata.' using errcode = '55000';
  end if;

  perform l.id from public.domestic_sale_lines l
  where l.sale_id = p_sale_id
  order by l.id
  for update;

  select count(*) into actual_count
  from public.domestic_sale_lines l where l.sale_id = p_sale_id;
  if actual_count <> requested_count or exists (
    select 1 from jsonb_array_elements(p_lines) as supplied(item)
    where not exists (
      select 1 from public.domestic_sale_lines l
      where l.sale_id = p_sale_id and l.id = (supplied.item ->> 'id')::uuid
    )
  ) then
    raise exception 'Line ids must match the complete current sale. Reload before saving.'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_lines) as supplied(id uuid, expected_revision integer)
    join public.domestic_sale_lines l on l.id = supplied.id and l.sale_id = p_sale_id
    where l.delivery_export_revision is distinct from supplied.expected_revision
  ) then
    raise exception 'Delivery metadata changed. Reload before saving.' using errcode = '40001';
  end if;

  -- One set-based update, guarded again by sale/revision. Any exception rolls
  -- back the entire RPC; no exception handler may swallow a partial failure.
  with saved as (
    update public.domestic_sale_lines l
    set external_order_no = case when supplied.item ? 'external_order_no'
          then nullif(btrim(supplied.item ->> 'external_order_no'), '') else l.external_order_no end,
        delivery_carton_no = case when supplied.item ? 'delivery_carton_no'
          then nullif(btrim(supplied.item ->> 'delivery_carton_no'), '') else l.delivery_carton_no end,
        delivery_spec = case when supplied.item ? 'delivery_spec'
          then nullif(btrim(supplied.item ->> 'delivery_spec'), '') else l.delivery_spec end,
        delivery_customer_name = case when supplied.item ? 'delivery_customer_name'
          then nullif(btrim(supplied.item ->> 'delivery_customer_name'), '') else l.delivery_customer_name end,
        delivery_export_revision = l.delivery_export_revision + 1,
        delivery_metadata_saved = true
    from jsonb_array_elements(p_lines) as supplied(item)
    where l.sale_id = p_sale_id
      and l.id = (supplied.item ->> 'id')::uuid
      and l.delivery_export_revision = (supplied.item ->> 'expected_revision')::integer
    returning l.id, l.line_no, l.external_order_no, l.delivery_carton_no,
      l.delivery_spec, l.delivery_customer_name, l.delivery_export_revision,
      l.delivery_metadata_saved, l.updated_at
  )
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'external_order_no', external_order_no,
    'delivery_carton_no', delivery_carton_no,
    'delivery_spec', delivery_spec,
    'delivery_customer_name', delivery_customer_name,
    'delivery_export_revision', delivery_export_revision,
    'delivery_metadata_saved', delivery_metadata_saved,
    'updated_at', updated_at
  ) order by line_no, id), '[]'::jsonb)
  into saved_count, saved_lines
  from saved;

  if saved_count <> requested_count then
    raise exception 'Delivery metadata save was incomplete. Reload before saving.' using errcode = '40001';
  end if;
  return jsonb_build_object('sale_id', p_sale_id, 'lines', saved_lines);
end;
$$;

revoke all on function public.save_domestic_delivery_metadata(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_domestic_delivery_metadata(uuid, jsonb)
  to authenticated;

notify pgrst, 'reload schema';
commit;
