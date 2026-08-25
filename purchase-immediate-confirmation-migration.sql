begin;

create or replace function public.create_confirmed_purchase_batch_v4(
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
begin
  if not public.is_internal_user() then
    raise exception 'Internal access is required.';
  end if;

  v_receipt_id := public.create_purchase_batch_v3(
    p_purchase_date,
    p_site_code,
    p_supplier_code,
    p_supplier_invoice_no,
    p_note,
    p_lines
  );

  perform public.confirm_purchase_receipt(v_receipt_id);
  return v_receipt_id;
end;
$$;

revoke all on function public.create_confirmed_purchase_batch_v4(date,text,text,text,text,jsonb) from public, anon;
grant execute on function public.create_confirmed_purchase_batch_v4(date,text,text,text,text,jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
