-- Purchase credit notes entered as positive quantities and stored as negative purchases.
-- Run after purchase-immediate-confirmation-migration.sql and purchase-correction-migration.sql.

begin;

alter table public.purchase_receipts
  drop constraint if exists purchase_receipts_receipt_type_check;
alter table public.purchase_receipts
  add constraint purchase_receipts_receipt_type_check
  check (receipt_type in ('order','advance','credit_note'));

-- Negative taxable bases mirror the existing positive tax truncation.
create or replace function public.purchase_receipt_calculated_tax(p_receipt_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(
    case
      when grouped.taxable_amount >= 0
        then floor(grouped.taxable_amount * grouped.tax_rate / 100.0)
      else ceil(grouped.taxable_amount * grouped.tax_rate / 100.0)
    end
  ),0)
  from (
    select line.tax_rate, coalesce(sum(line.line_amount),0) as taxable_amount
    from public.purchase_receipt_lines line
    where line.receipt_id = p_receipt_id
    group by line.tax_rate
  ) grouped;
$$;

create or replace function public.create_confirmed_purchase_batch_v5(
  p_purchase_date date,
  p_site_code text,
  p_supplier_code text,
  p_supplier_invoice_no text default null,
  p_note text default null,
  p_entry_type text default 'purchase',
  p_lines jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt_id uuid;
  v_entry_type text := lower(btrim(coalesce(p_entry_type,'purchase')));
begin
  if not public.is_internal_user() then
    raise exception 'Internal access is required.';
  end if;
  if v_entry_type not in ('purchase','credit_note') then
    raise exception 'Invalid purchase entry type: %', p_entry_type;
  end if;

  v_receipt_id := public.create_purchase_batch_v3(
    p_purchase_date,
    p_site_code,
    p_supplier_code,
    p_supplier_invoice_no,
    p_note,
    p_lines
  );

  if v_entry_type = 'credit_note' then
    update public.purchase_receipts
    set receipt_type = 'credit_note',
        updated_at = now()
    where id = v_receipt_id;

    update public.purchase_receipt_lines
    set actual_qty = -abs(actual_qty),
        line_amount = -abs(line_amount),
        track_inventory = false,
        updated_at = now()
    where receipt_id = v_receipt_id;

    perform public.refresh_purchase_receipt_from_lines(v_receipt_id);
  end if;

  perform public.confirm_purchase_receipt(v_receipt_id);
  return v_receipt_id;
end;
$$;

revoke all on function public.purchase_receipt_calculated_tax(uuid) from public, anon, authenticated;
revoke all on function public.create_confirmed_purchase_batch_v5(date,text,text,text,text,text,jsonb) from public, anon;
grant execute on function public.create_confirmed_purchase_batch_v5(date,text,text,text,text,text,jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
