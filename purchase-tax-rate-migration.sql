-- Purchase tax rates and automatic tax calculation.
-- Run after site-partner-purchase-migration.sql and advance-purchase-batch-migration.sql.

begin;

alter table public.purchase_receipt_lines
  add column if not exists tax_rate smallint not null default 8;

alter table public.purchase_receipt_lines
  drop constraint if exists purchase_receipt_lines_tax_rate_check;
alter table public.purchase_receipt_lines
  add constraint purchase_receipt_lines_tax_rate_check
  check (tax_rate in (0,8,10));

alter table public.purchase_receipts
  add column if not exists tax_override boolean not null default true;

-- Existing tax amounts stay manual; only receipts created after this migration
-- start in automatic mode.
alter table public.purchase_receipts
  alter column tax_override set default false;

create or replace function public.purchase_receipt_calculated_tax(p_receipt_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(floor(grouped.taxable_amount * grouped.tax_rate / 100.0)),0)
  from (
    select line.tax_rate, coalesce(sum(line.line_amount),0) as taxable_amount
    from public.purchase_receipt_lines line
    where line.receipt_id = p_receipt_id
    group by line.tax_rate
  ) grouped;
$$;

create or replace function public.prepare_purchase_receipt_totals()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not new.tax_override then
    new.tax_amount := public.purchase_receipt_calculated_tax(new.id);
  end if;
  new.total_amount := coalesce(new.subtotal,0)
    + coalesce(new.shipping_fee,0)
    + coalesce(new.other_fee,0)
    + coalesce(new.tax_amount,0);
  return new;
end;
$$;

drop trigger if exists trg_prepare_purchase_receipt_totals on public.purchase_receipts;
create trigger trg_prepare_purchase_receipt_totals
before insert or update of subtotal,shipping_fee,other_fee,tax_amount,tax_override
on public.purchase_receipts
for each row execute function public.prepare_purchase_receipt_totals();

create or replace function public.refresh_purchase_receipt_from_lines(p_receipt_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  calculated_subtotal numeric;
begin
  select coalesce(sum(line.line_amount),0)
  into calculated_subtotal
  from public.purchase_receipt_lines line
  where line.receipt_id = p_receipt_id;

  update public.purchase_receipts
  set subtotal = calculated_subtotal,
      updated_at = now()
  where id = p_receipt_id;
end;
$$;

create or replace function public.refresh_purchase_receipt_after_line_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    perform public.refresh_purchase_receipt_from_lines(old.receipt_id);
    return old;
  end if;
  perform public.refresh_purchase_receipt_from_lines(new.receipt_id);
  if tg_op = 'UPDATE' and old.receipt_id is distinct from new.receipt_id then
    perform public.refresh_purchase_receipt_from_lines(old.receipt_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_refresh_purchase_receipt_after_line_change on public.purchase_receipt_lines;
create trigger trg_refresh_purchase_receipt_after_line_change
after insert or update of receipt_id,line_amount,tax_rate or delete
on public.purchase_receipt_lines
for each row execute function public.refresh_purchase_receipt_after_line_change();

create or replace function public.create_purchase_batch_v3(
  p_purchase_date date,
  p_site_code text,
  p_supplier_code text,
  p_supplier_invoice_no text default null,
  p_note text default null,
  p_lines jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt_id uuid;
  v_purchase_line_id uuid;
  v_source_sales_id uuid;
  v_seen_sales_ids uuid[] := '{}'::uuid[];
  v_supplier_name text;
  v_line jsonb;
  v_product_name text;
  v_actual_qty numeric;
  v_actual_unit text;
  v_unit_price numeric;
  v_price_unit text;
  v_tax_rate smallint;
  v_line_amount numeric;
  v_has_sales_links boolean := false;
begin
  if not public.is_internal_user() then
    raise exception 'Internal access is required.';
  end if;
  if p_purchase_date is null then
    raise exception 'Purchase date is required.';
  end if;
  if not exists (
    select 1 from public.site_master
    where site_code = p_site_code and is_active
  ) then
    raise exception 'Site not found: %', p_site_code;
  end if;

  select supplier_name into v_supplier_name
  from public.supplier_master
  where supplier_code = p_supplier_code and is_active;
  if v_supplier_name is null then
    raise exception 'Supplier not found: %', p_supplier_code;
  end if;

  if jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0
     or jsonb_array_length(p_lines) > 500 then
    raise exception 'Purchase lines must contain between 1 and 500 rows.';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_product_name := btrim(coalesce(v_line->>'product_name',''));
    v_actual_qty := nullif(btrim(coalesce(v_line->>'actual_qty','')),'')::numeric;
    v_actual_unit := coalesce(nullif(btrim(coalesce(v_line->>'actual_unit','')),''),'Kg');
    v_unit_price := nullif(btrim(coalesce(v_line->>'unit_price','')),'')::numeric;
    v_price_unit := coalesce(nullif(btrim(coalesce(v_line->>'price_unit','')),''),'Kg');
    v_tax_rate := coalesce(nullif(btrim(coalesce(v_line->>'tax_rate','')),'')::smallint,8);
    if v_product_name = '' then raise exception 'Product name is required.'; end if;
    if v_actual_qty is null or v_actual_qty <= 0 then raise exception 'Actual quantity must be greater than zero.'; end if;
    if v_unit_price is null or v_unit_price < 0 then raise exception 'Unit price must be zero or greater.'; end if;
    if v_actual_unit not in ('Kg','pkt','PC','CS') then raise exception 'Invalid actual unit: %', v_actual_unit; end if;
    if v_price_unit not in ('Kg','pkt','PC','CS') then raise exception 'Invalid price unit: %', v_price_unit; end if;
    if v_tax_rate not in (0,8,10) then raise exception 'Invalid tax rate: %', v_tax_rate; end if;
    if v_line ? 'source_sales_ids' and jsonb_typeof(v_line->'source_sales_ids') <> 'array' then
      raise exception 'source_sales_ids must be an array.';
    end if;
    for v_source_sales_id in
      select value::uuid
      from jsonb_array_elements_text(
        case when jsonb_typeof(v_line->'source_sales_ids') = 'array'
          then v_line->'source_sales_ids' else '[]'::jsonb end
      )
    loop
      if v_source_sales_id = any(v_seen_sales_ids)
         or exists (
           select 1 from public.purchase_sales_links
           where sales_record_id = v_source_sales_id
         ) then
        raise exception using
          errcode = '23505',
          message = format('Sales record has already been imported: %s', v_source_sales_id);
      end if;
      v_seen_sales_ids := array_append(v_seen_sales_ids,v_source_sales_id);
      v_has_sales_links := true;
    end loop;
  end loop;

  insert into public.purchase_receipts (
    receipt_type, status, site_code, supplier_code, supplier_name_snapshot,
    purchase_date, supplier_invoice_no, invoice_date, subtotal, tax_amount,
    tax_override, total_amount, note, created_by
  ) values (
    case when v_has_sales_links then 'order' else 'advance' end,
    case when coalesce(btrim(p_supplier_invoice_no),'') = '' then 'expected' else 'invoice_received' end,
    p_site_code,
    p_supplier_code,
    v_supplier_name,
    p_purchase_date,
    nullif(btrim(p_supplier_invoice_no),''),
    case when coalesce(btrim(p_supplier_invoice_no),'') = '' then null else p_purchase_date end,
    0,
    0,
    false,
    0,
    nullif(btrim(p_note),''),
    auth.uid()
  ) returning id into v_receipt_id;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_product_name := btrim(v_line->>'product_name');
    v_actual_qty := (v_line->>'actual_qty')::numeric;
    v_actual_unit := coalesce(nullif(btrim(coalesce(v_line->>'actual_unit','')),''),'Kg');
    v_unit_price := (v_line->>'unit_price')::numeric;
    v_price_unit := coalesce(nullif(btrim(coalesce(v_line->>'price_unit','')),''),'Kg');
    v_tax_rate := coalesce(nullif(btrim(coalesce(v_line->>'tax_rate','')),'')::smallint,8);
    v_line_amount := v_actual_qty * v_unit_price;
    insert into public.purchase_receipt_lines (
      receipt_id, product_code, product_name, origin, actual_qty, actual_unit,
      unit_price, price_unit, tax_rate, line_amount, track_inventory, note
    ) values (
      v_receipt_id,
      nullif(btrim(v_line->>'product_code'),''),
      v_product_name,
      nullif(btrim(v_line->>'origin'),''),
      v_actual_qty,
      v_actual_unit,
      v_unit_price,
      v_price_unit,
      v_tax_rate,
      v_line_amount,
      coalesce((v_line->>'track_inventory')::boolean,true),
      nullif(btrim(v_line->>'note'),'')
    ) returning id into v_purchase_line_id;

    for v_source_sales_id in
      select value::uuid
      from jsonb_array_elements_text(
        case when jsonb_typeof(v_line->'source_sales_ids') = 'array'
          then v_line->'source_sales_ids' else '[]'::jsonb end
      )
    loop
      insert into public.purchase_sales_links (
        sales_record_id, purchase_receipt_id, purchase_line_id, created_by
      ) values (
        v_source_sales_id, v_receipt_id, v_purchase_line_id, auth.uid()
      );
    end loop;
  end loop;

  return v_receipt_id;
end;
$$;

revoke all on function public.purchase_receipt_calculated_tax(uuid) from public,anon,authenticated;
revoke all on function public.prepare_purchase_receipt_totals() from public,anon,authenticated;
revoke all on function public.refresh_purchase_receipt_from_lines(uuid) from public,anon,authenticated;
revoke all on function public.refresh_purchase_receipt_after_line_change() from public,anon,authenticated;
revoke all on function public.create_purchase_batch_v3(date,text,text,text,text,jsonb) from public,anon;
grant execute on function public.create_purchase_batch_v3(date,text,text,text,text,jsonb) to authenticated;

commit;
