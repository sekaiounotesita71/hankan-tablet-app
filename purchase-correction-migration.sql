-- Controlled correction flow for confirmed purchase receipts.
-- Confirmed receipts can only be unlocked by an administrator with a reason.

begin;

alter table public.purchase_receipts
  add column if not exists correction_unlocked boolean not null default false,
  add column if not exists correction_count integer not null default 0,
  add column if not exists last_correction_reason text,
  add column if not exists last_correction_at timestamptz,
  add column if not exists last_corrected_by uuid references auth.users(id) on delete set null;

create table if not exists public.purchase_correction_log (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.purchase_receipts(id) on delete cascade,
  action text not null check (action in ('unlock','reconfirm')),
  reason text,
  receipt_snapshot jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_purchase_correction_log_receipt
  on public.purchase_correction_log(receipt_id,created_at desc);

alter table public.purchase_correction_log enable row level security;

drop policy if exists "internal read purchase correction log"
  on public.purchase_correction_log;
create policy "internal read purchase correction log"
on public.purchase_correction_log for select to authenticated
using (public.is_internal_user());

grant select on public.purchase_correction_log to authenticated;
revoke insert, update, delete on public.purchase_correction_log from public, anon, authenticated;

create or replace function public.guard_confirmed_purchase_receipt()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status = 'confirmed'
     and coalesce(current_setting('app.purchase_correction',true),'') <> 'on'
     and (
       new.status is distinct from old.status
       or new.receipt_type is distinct from old.receipt_type
       or new.site_code is distinct from old.site_code
       or new.supplier_code is distinct from old.supplier_code
       or new.supplier_name_snapshot is distinct from old.supplier_name_snapshot
       or new.purchase_date is distinct from old.purchase_date
       or new.supplier_invoice_no is distinct from old.supplier_invoice_no
       or new.invoice_date is distinct from old.invoice_date
       or new.subtotal is distinct from old.subtotal
       or new.shipping_fee is distinct from old.shipping_fee
       or new.other_fee is distinct from old.other_fee
       or new.tax_amount is distinct from old.tax_amount
       or new.total_amount is distinct from old.total_amount
       or new.note is distinct from old.note
     ) then
    raise exception 'Confirmed purchase receipt is locked. Use correction unlock.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_confirmed_purchase_receipt on public.purchase_receipts;
create trigger trg_guard_confirmed_purchase_receipt
before update on public.purchase_receipts
for each row execute function public.guard_confirmed_purchase_receipt();

create or replace function public.guard_confirmed_purchase_line()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  target_receipt_id uuid;
begin
  target_receipt_id := coalesce(new.receipt_id,old.receipt_id);
  if exists (
    select 1 from public.purchase_receipts
    where id = target_receipt_id and status = 'confirmed'
  ) and coalesce(current_setting('app.purchase_correction',true),'') <> 'on' then
    raise exception 'Confirmed purchase receipt lines are locked. Use correction unlock.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_confirmed_purchase_line on public.purchase_receipt_lines;
create trigger trg_guard_confirmed_purchase_line
before insert or update or delete on public.purchase_receipt_lines
for each row execute function public.guard_confirmed_purchase_line();

create or replace function public.unlock_purchase_receipt_for_correction(
  p_receipt_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  receipt_row public.purchase_receipts;
  other_receipt_count integer := 0;
  reason_text text := btrim(coalesce(p_reason,''));
begin
  if not public.is_master_admin() then
    raise exception 'Administrator access is required.';
  end if;
  if char_length(reason_text) < 4 then
    raise exception 'Correction reason must be at least 4 characters.';
  end if;

  select * into receipt_row
  from public.purchase_receipts
  where id = p_receipt_id
  for update;

  if receipt_row.id is null then raise exception 'Purchase receipt not found.'; end if;
  if receipt_row.status <> 'confirmed' then
    raise exception 'Only confirmed purchase receipts can be unlocked.';
  end if;

  if receipt_row.accounts_payable_id is not null and exists (
    select 1 from public.accounts_payable_payments
    where payable_id = receipt_row.accounts_payable_id
  ) then
    raise exception 'Purchase receipt has recorded payments and cannot be unlocked.';
  end if;

  if exists (
    select 1
    from public.purchase_receipt_lines line
    join public.inventory_lots lot on lot.purchase_line_id = line.id
    join public.inventory_allocations allocation on allocation.inventory_lot_id = lot.id
    where line.receipt_id = p_receipt_id
  ) then
    raise exception 'Purchase inventory has already been allocated and cannot be unlocked.';
  end if;

  perform set_config('app.purchase_correction','on',true);

  insert into public.purchase_correction_log (
    receipt_id,action,reason,receipt_snapshot,created_by
  ) values (
    p_receipt_id,'unlock',reason_text,to_jsonb(receipt_row),auth.uid()
  );

  delete from public.inventory_lots lot
  using public.purchase_receipt_lines line
  where lot.purchase_line_id = line.id
    and line.receipt_id = p_receipt_id;

  if receipt_row.accounts_payable_id is not null then
    select count(*) into other_receipt_count
    from public.purchase_receipts
    where accounts_payable_id = receipt_row.accounts_payable_id
      and id <> p_receipt_id;

    if other_receipt_count = 0 then
      delete from public.accounts_payable
      where id = receipt_row.accounts_payable_id;
    else
      update public.purchase_receipts
      set accounts_payable_id = null,
          updated_at = now()
      where id = p_receipt_id;

      update public.accounts_payable payable
      set subtotal_jpy = totals.subtotal,
          shipping_amount_jpy = totals.shipping,
          other_amount_jpy = totals.other_fee,
          tax_amount_jpy = totals.tax,
          amount_jpy = totals.total + payable.adjustment_amount_jpy,
          period_from = totals.period_from,
          period_to = totals.period_to,
          updated_by = auth.uid()
      from (
        select
          coalesce(sum(receipt.subtotal),0) as subtotal,
          coalesce(sum(receipt.shipping_fee),0) as shipping,
          coalesce(sum(receipt.other_fee),0) as other_fee,
          coalesce(sum(receipt.tax_amount),0) as tax,
          coalesce(sum(receipt.total_amount),0) as total,
          min(receipt.purchase_date) as period_from,
          max(receipt.purchase_date) as period_to
        from public.purchase_receipts receipt
        where receipt.accounts_payable_id = receipt_row.accounts_payable_id
      ) totals
      where payable.id = receipt_row.accounts_payable_id;
    end if;
  end if;

  update public.purchase_receipts
  set status = 'expected',
      correction_unlocked = true,
      correction_count = correction_count + 1,
      last_correction_reason = reason_text,
      last_correction_at = now(),
      last_corrected_by = auth.uid(),
      confirmed_at = null,
      confirmed_by = null,
      accounts_payable_id = null,
      updated_at = now()
  where id = p_receipt_id;

  return p_receipt_id;
end;
$$;

create or replace function public.confirm_purchase_receipt(p_receipt_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  receipt_row public.purchase_receipts;
  updated_receipt public.purchase_receipts;
begin
  if not public.is_internal_user() then raise exception 'Internal access is required.'; end if;

  select * into receipt_row
  from public.purchase_receipts
  where id = p_receipt_id
  for update;

  if receipt_row.id is null then raise exception 'Purchase receipt not found.'; end if;
  if receipt_row.status = 'confirmed' then return p_receipt_id; end if;
  if receipt_row.status = 'cancelled' then raise exception 'Cancelled purchase receipt cannot be confirmed.'; end if;

  update public.purchase_receipts
  set status = 'confirmed',
      supplier_invoice_no = coalesce(
        nullif(btrim(supplier_invoice_no),''),
        public.next_purchase_internal_reference(purchase_date,supplier_code)
      ),
      invoice_date = coalesce(invoice_date,purchase_date),
      subtotal = totals.subtotal,
      total_amount = totals.subtotal + shipping_fee + other_fee + tax_amount,
      correction_unlocked = false,
      confirmed_at = now(),
      confirmed_by = auth.uid(),
      updated_at = now()
  from (
    select coalesce(sum(line_amount),0) subtotal
    from public.purchase_receipt_lines
    where receipt_id = p_receipt_id
  ) totals
  where id = p_receipt_id
  returning public.purchase_receipts.* into updated_receipt;

  insert into public.inventory_lots (
    purchase_line_id,site_code,supplier_code,product_code,product_name,origin,
    received_date,received_qty,available_qty,unit,unit_cost,note
  )
  select line.id,updated_receipt.site_code,updated_receipt.supplier_code,line.product_code,
         line.product_name,line.origin,updated_receipt.purchase_date,
         coalesce(line.actual_qty,0),coalesce(line.actual_qty,0),line.actual_unit,
         line.unit_price,line.note
  from public.purchase_receipt_lines line
  where line.receipt_id = p_receipt_id
    and line.track_inventory
    and coalesce(line.actual_qty,0) > 0
  on conflict (purchase_line_id) do update
  set site_code = excluded.site_code,
      supplier_code = excluded.supplier_code,
      product_code = excluded.product_code,
      product_name = excluded.product_name,
      origin = excluded.origin,
      received_date = excluded.received_date,
      received_qty = excluded.received_qty,
      available_qty = excluded.available_qty,
      unit = excluded.unit,
      unit_cost = excluded.unit_cost,
      note = excluded.note,
      updated_at = now();

  if receipt_row.correction_unlocked then
    insert into public.purchase_correction_log (
      receipt_id,action,reason,receipt_snapshot,created_by
    ) values (
      p_receipt_id,'reconfirm',receipt_row.last_correction_reason,
      to_jsonb(updated_receipt),auth.uid()
    );
  end if;

  if to_regprocedure('public.sync_confirmed_purchases_to_payables()') is not null then
    perform public.sync_confirmed_purchases_to_payables();
  end if;

  return p_receipt_id;
end;
$$;

revoke all on function public.guard_confirmed_purchase_receipt() from public, anon, authenticated;
revoke all on function public.guard_confirmed_purchase_line() from public, anon, authenticated;
revoke all on function public.unlock_purchase_receipt_for_correction(uuid,text) from public, anon;
grant execute on function public.unlock_purchase_receipt_for_correction(uuid,text) to authenticated;
revoke all on function public.confirm_purchase_receipt(uuid) from public, anon;
grant execute on function public.confirm_purchase_receipt(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
