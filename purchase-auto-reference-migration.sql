-- Automatically assign an internal reference to every purchase receipt.
-- Existing supplier invoice numbers are preserved.

begin;

create sequence if not exists public.purchase_internal_reference_seq;

create or replace function public.next_purchase_internal_reference(
  p_purchase_date date,
  p_supplier_code text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  supplier_part text;
begin
  supplier_part := upper(regexp_replace(coalesce(p_supplier_code,''),'[^A-Za-z0-9]+','','g'));
  if supplier_part = '' then supplier_part := 'SUP'; end if;
  return format(
    'PUR-%s-%s-%s',
    to_char(coalesce(p_purchase_date,current_date),'YYYYMMDD'),
    left(supplier_part,12),
    to_char(nextval('public.purchase_internal_reference_seq'::regclass),'FM000000000')
  );
end;
$$;

revoke all on function public.next_purchase_internal_reference(date,text) from public, anon, authenticated;

create or replace function public.assign_purchase_internal_reference()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(btrim(new.supplier_invoice_no),'') is null then
    new.supplier_invoice_no := public.next_purchase_internal_reference(new.purchase_date,new.supplier_code);
  end if;
  if new.invoice_date is null then new.invoice_date := new.purchase_date; end if;
  return new;
end;
$$;

revoke all on function public.assign_purchase_internal_reference() from public, anon, authenticated;

drop trigger if exists trg_purchase_receipts_internal_reference on public.purchase_receipts;
create trigger trg_purchase_receipts_internal_reference
before insert or update of supplier_invoice_no, purchase_date, supplier_code
on public.purchase_receipts
for each row execute function public.assign_purchase_internal_reference();

update public.purchase_receipts
set supplier_invoice_no = public.next_purchase_internal_reference(purchase_date,supplier_code),
    invoice_date = coalesce(invoice_date,purchase_date),
    updated_at = now()
where nullif(btrim(supplier_invoice_no),'') is null;

create or replace function public.confirm_purchase_receipt(p_receipt_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  receipt_row public.purchase_receipts;
begin
  if not public.is_internal_user() then raise exception 'Internal access is required.'; end if;
  select * into receipt_row from public.purchase_receipts where id = p_receipt_id;
  if receipt_row.id is null then raise exception 'Purchase receipt not found.'; end if;

  update public.purchase_receipts
  set status = 'confirmed',
      supplier_invoice_no = coalesce(
        nullif(btrim(supplier_invoice_no),''),
        public.next_purchase_internal_reference(purchase_date,supplier_code)
      ),
      invoice_date = coalesce(invoice_date,purchase_date),
      subtotal = totals.subtotal,
      total_amount = totals.subtotal + shipping_fee + other_fee + tax_amount,
      confirmed_at = now(),
      confirmed_by = auth.uid(),
      updated_at = now()
  from (
    select coalesce(sum(line_amount),0) subtotal
    from public.purchase_receipt_lines
    where receipt_id = p_receipt_id
  ) totals
  where id = p_receipt_id;

  insert into public.inventory_lots (
    purchase_line_id, site_code, supplier_code, product_code, product_name, origin,
    received_date, received_qty, available_qty, unit, unit_cost, note
  )
  select line.id, receipt_row.site_code, receipt_row.supplier_code, line.product_code,
         line.product_name, line.origin, receipt_row.purchase_date,
         coalesce(line.actual_qty,0), coalesce(line.actual_qty,0), line.actual_unit,
         line.unit_price, line.note
  from public.purchase_receipt_lines line
  where line.receipt_id = p_receipt_id and line.track_inventory and coalesce(line.actual_qty,0) > 0
  on conflict (purchase_line_id) do update
  set received_qty = excluded.received_qty,
      available_qty = excluded.available_qty,
      unit_cost = excluded.unit_cost,
      origin = excluded.origin,
      updated_at = now();

  return p_receipt_id;
end;
$$;

revoke all on function public.confirm_purchase_receipt(uuid) from public, anon;
grant execute on function public.confirm_purchase_receipt(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
