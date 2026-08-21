-- Atomic multi-line entry for manual advance purchases and sales-linked purchases.
-- Run after site-partner-purchase-migration.sql.

begin;

create table if not exists public.purchase_sales_links (
  sales_record_id uuid primary key references public.sales_records(id) on delete cascade,
  purchase_receipt_id uuid not null references public.purchase_receipts(id) on delete cascade,
  purchase_line_id uuid not null references public.purchase_receipt_lines(id) on delete cascade,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_purchase_sales_links_receipt
  on public.purchase_sales_links(purchase_receipt_id, purchase_line_id);

alter table public.purchase_sales_links enable row level security;
drop policy if exists "internal manage purchase sales links" on public.purchase_sales_links;
create policy "internal manage purchase sales links"
  on public.purchase_sales_links for all to authenticated
  using (public.is_internal_user())
  with check (public.is_internal_user());

grant select, insert, delete on public.purchase_sales_links to authenticated;

create or replace function public.create_advance_purchase_batch(
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
  v_supplier_name text;
  v_line jsonb;
  v_product_name text;
  v_actual_qty numeric;
  v_actual_unit text;
  v_unit_price numeric;
  v_price_unit text;
  v_line_amount numeric;
  v_subtotal numeric := 0;
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
    if v_product_name = '' then raise exception 'Product name is required.'; end if;
    if v_actual_qty is null or v_actual_qty <= 0 then raise exception 'Actual quantity must be greater than zero.'; end if;
    if v_unit_price is null or v_unit_price < 0 then raise exception 'Unit price must be zero or greater.'; end if;
    if v_actual_unit not in ('Kg','pkt','PC','CS') then raise exception 'Invalid actual unit: %', v_actual_unit; end if;
    if v_price_unit not in ('Kg','pkt','PC','CS') then raise exception 'Invalid price unit: %', v_price_unit; end if;
    v_subtotal := v_subtotal + (v_actual_qty * v_unit_price);
  end loop;

  insert into public.purchase_receipts (
    receipt_type, status, site_code, supplier_code, supplier_name_snapshot,
    purchase_date, supplier_invoice_no, invoice_date, subtotal, total_amount,
    note, created_by
  ) values (
    'advance',
    case when coalesce(btrim(p_supplier_invoice_no),'') = '' then 'expected' else 'invoice_received' end,
    p_site_code,
    p_supplier_code,
    v_supplier_name,
    p_purchase_date,
    nullif(btrim(p_supplier_invoice_no),''),
    case when coalesce(btrim(p_supplier_invoice_no),'') = '' then null else p_purchase_date end,
    v_subtotal,
    v_subtotal,
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
    v_line_amount := v_actual_qty * v_unit_price;
    insert into public.purchase_receipt_lines (
      receipt_id, product_code, product_name, origin, actual_qty, actual_unit,
      unit_price, price_unit, line_amount, track_inventory, note
    ) values (
      v_receipt_id,
      nullif(btrim(v_line->>'product_code'),''),
      v_product_name,
      nullif(btrim(v_line->>'origin'),''),
      v_actual_qty,
      v_actual_unit,
      v_unit_price,
      v_price_unit,
      v_line_amount,
      coalesce((v_line->>'track_inventory')::boolean,true),
      nullif(btrim(v_line->>'note'),'')
    );
  end loop;

  return v_receipt_id;
end;
$$;

revoke all on function public.create_advance_purchase_batch(date,text,text,text,text,jsonb) from public;
grant execute on function public.create_advance_purchase_batch(date,text,text,text,text,jsonb) to authenticated;

-- Version 2 persists the sales records used by each purchase line. The primary
-- key on purchase_sales_links prevents duplicate imports across devices.
create or replace function public.create_advance_purchase_batch_v2(
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
  v_line_amount numeric;
  v_subtotal numeric := 0;
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
    if v_product_name = '' then raise exception 'Product name is required.'; end if;
    if v_actual_qty is null or v_actual_qty <= 0 then raise exception 'Actual quantity must be greater than zero.'; end if;
    if v_unit_price is null or v_unit_price < 0 then raise exception 'Unit price must be zero or greater.'; end if;
    if v_actual_unit not in ('Kg','pkt','PC','CS') then raise exception 'Invalid actual unit: %', v_actual_unit; end if;
    if v_price_unit not in ('Kg','pkt','PC','CS') then raise exception 'Invalid price unit: %', v_price_unit; end if;
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
    end loop;
    v_subtotal := v_subtotal + (v_actual_qty * v_unit_price);
  end loop;

  insert into public.purchase_receipts (
    receipt_type, status, site_code, supplier_code, supplier_name_snapshot,
    purchase_date, supplier_invoice_no, invoice_date, subtotal, total_amount,
    note, created_by
  ) values (
    'order',
    case when coalesce(btrim(p_supplier_invoice_no),'') = '' then 'expected' else 'invoice_received' end,
    p_site_code,
    p_supplier_code,
    v_supplier_name,
    p_purchase_date,
    nullif(btrim(p_supplier_invoice_no),''),
    case when coalesce(btrim(p_supplier_invoice_no),'') = '' then null else p_purchase_date end,
    v_subtotal,
    v_subtotal,
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
    v_line_amount := v_actual_qty * v_unit_price;
    insert into public.purchase_receipt_lines (
      receipt_id, product_code, product_name, origin, actual_qty, actual_unit,
      unit_price, price_unit, line_amount, track_inventory, note
    ) values (
      v_receipt_id,
      nullif(btrim(v_line->>'product_code'),''),
      v_product_name,
      nullif(btrim(v_line->>'origin'),''),
      v_actual_qty,
      v_actual_unit,
      v_unit_price,
      v_price_unit,
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

revoke all on function public.create_advance_purchase_batch_v2(date,text,text,text,text,jsonb) from public;
grant execute on function public.create_advance_purchase_batch_v2(date,text,text,text,text,jsonb) to authenticated;

-- Previous versions classified every batch as an advance purchase. A linked
-- sales record proves that the receipt is a regular sales-linked purchase.
update public.purchase_receipts receipt
set receipt_type = 'order',
    updated_at = now()
where receipt.receipt_type = 'advance'
  and exists (
    select 1
    from public.purchase_sales_links link
    where link.purchase_receipt_id = receipt.id
  );

commit;
