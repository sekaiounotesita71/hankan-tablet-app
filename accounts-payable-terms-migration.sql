-- Closing-day based due dates and cash-on-entry supplier payments.
-- Run after accounts-payable-migration.sql and accounts-payable-closing-migration.sql.

begin;

alter table public.accounts_payable_supplier_profiles
  add column if not exists payment_mode text not null default 'credit';

alter table public.accounts_payable_supplier_profiles
  drop constraint if exists accounts_payable_supplier_profiles_payment_mode_check;
alter table public.accounts_payable_supplier_profiles
  add constraint accounts_payable_supplier_profiles_payment_mode_check
  check (payment_mode in ('credit','cash_on_entry'));

alter table public.accounts_payable_payments
  add column if not exists source_key text;

create unique index if not exists uq_accounts_payable_payment_source
  on public.accounts_payable_payments(source_key);

create or replace function public.accounts_payable_due_date(
  p_invoice_date date,
  p_closing_day smallint,
  p_payment_month_offset smallint,
  p_payment_day smallint
)
returns date
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  invoice_month date;
  invoice_month_last_day date;
  effective_closing_date date;
  closing_month date;
  target_month date;
  target_last_day date;
  target_day integer;
begin
  if p_invoice_date is null then return null; end if;

  invoice_month := date_trunc('month',p_invoice_date)::date;
  invoice_month_last_day := (invoice_month + interval '1 month - 1 day')::date;
  effective_closing_date := invoice_month + (
    least(
      greatest(coalesce(p_closing_day,31),1),
      extract(day from invoice_month_last_day)::integer
    ) - 1
  );
  closing_month := case
    when p_invoice_date <= effective_closing_date then invoice_month
    else (invoice_month + interval '1 month')::date
  end;
  target_month := (
    closing_month
    + make_interval(months => greatest(coalesce(p_payment_month_offset,1),0)::integer)
  )::date;
  target_last_day := (target_month + interval '1 month - 1 day')::date;
  target_day := least(
    greatest(coalesce(p_payment_day,31),1),
    extract(day from target_last_day)::integer
  );
  return target_month + (target_day - 1);
end;
$$;

create or replace function public.sync_confirmed_purchases_to_payables()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  grouped record;
  cash_payable record;
  payable_id uuid;
  closing_day smallint;
  payment_month_offset smallint;
  payment_day smallint;
  payment_mode text;
  automatic_payment_amount numeric;
  automatic_payment_key text;
  processed integer := 0;
begin
  if not public.is_internal_user() then
    raise exception 'Internal access is required.';
  end if;

  for grouped in
    select
      receipt.supplier_code,
      max(coalesce(receipt.supplier_name_snapshot,supplier.supplier_name)) as supplier_name,
      btrim(receipt.supplier_invoice_no) as invoice_no,
      coalesce(max(receipt.invoice_date),max(receipt.purchase_date)) as invoice_date,
      min(receipt.purchase_date) as period_from,
      max(receipt.purchase_date) as period_to,
      array_agg(receipt.id order by receipt.purchase_date,receipt.created_at) as receipt_ids
    from public.purchase_receipts receipt
    join public.supplier_master supplier
      on supplier.supplier_code = receipt.supplier_code
    where receipt.status = 'confirmed'
      and receipt.accounts_payable_id is null
      and nullif(btrim(receipt.supplier_invoice_no),'') is not null
    group by receipt.supplier_code,btrim(receipt.supplier_invoice_no)
    order by min(receipt.purchase_date),receipt.supplier_code
  loop
    select
      coalesce(profile.closing_day,31),
      coalesce(profile.payment_month_offset,1),
      coalesce(profile.payment_day,31),
      coalesce(profile.payment_mode,'credit')
    into closing_day,payment_month_offset,payment_day,payment_mode
    from (select 1) seed
    left join public.accounts_payable_supplier_profiles profile
      on profile.supplier_code = grouped.supplier_code;

    insert into public.accounts_payable (
      source_key,source_type,supplier_code,supplier_name,invoice_no,
      invoice_date,period_from,period_to,due_date,memo,
      created_by,updated_by
    ) values (
      'purchase:' || grouped.supplier_code || ':' || grouped.invoice_no,
      'purchase',grouped.supplier_code,grouped.supplier_name,grouped.invoice_no,
      grouped.invoice_date,grouped.period_from,grouped.period_to,
      case
        when payment_mode = 'cash_on_entry' then grouped.invoice_date
        else public.accounts_payable_due_date(
          grouped.invoice_date,closing_day,payment_month_offset,payment_day
        )
      end,
      '仕入確定データから自動作成',auth.uid(),auth.uid()
    )
    on conflict (supplier_code,invoice_no)
      where invoice_no is not null and btrim(invoice_no) <> ''
    do update set
      supplier_name = excluded.supplier_name,
      invoice_date = excluded.invoice_date,
      period_from = least(public.accounts_payable.period_from,excluded.period_from),
      period_to = greatest(public.accounts_payable.period_to,excluded.period_to),
      due_date = excluded.due_date,
      updated_by = auth.uid()
    returning id into payable_id;

    update public.purchase_receipts
    set accounts_payable_id = payable_id,
        updated_at = now()
    where id = any(grouped.receipt_ids)
      and accounts_payable_id is null;

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
      where receipt.accounts_payable_id = payable_id
    ) totals
    where payable.id = payable_id;

    processed := processed + 1;
  end loop;

  update public.accounts_payable payable
  set due_date = public.accounts_payable_due_date(
        payable.invoice_date,
        profile.closing_day,
        profile.payment_month_offset,
        profile.payment_day
      ),
      updated_by = auth.uid()
  from public.accounts_payable_supplier_profiles profile
  where profile.supplier_code = payable.supplier_code
    and profile.payment_mode = 'credit'
    and payable.source_type = 'purchase'
    and payable.closing_id is null;

  for cash_payable in
    select payable.id,payable.invoice_date,payable.amount_jpy
    from public.accounts_payable payable
    join public.accounts_payable_supplier_profiles profile
      on profile.supplier_code = payable.supplier_code
     and profile.payment_mode = 'cash_on_entry'
    where payable.source_type = 'purchase'
      and payable.closing_id is null
    for update of payable
  loop
    automatic_payment_key := 'cash-purchase:' || cash_payable.id::text;

    update public.accounts_payable
    set due_date = cash_payable.invoice_date,
        updated_by = auth.uid()
    where id = cash_payable.id;

    select greatest(
      coalesce(cash_payable.amount_jpy,0)
      - coalesce(sum(payment.amount_jpy) filter (
          where payment.source_key is distinct from automatic_payment_key
        ),0),
      0
    )
    into automatic_payment_amount
    from public.accounts_payable_payments payment
    where payment.payable_id = cash_payable.id;

    if automatic_payment_amount > 0 then
      insert into public.accounts_payable_payments (
        payable_id,payment_date,amount_jpy,bank_fee_jpy,
        reference_no,memo,source_key,created_by,updated_by
      ) values (
        cash_payable.id,cash_payable.invoice_date,automatic_payment_amount,0,
        'AUTO-CASH','都度現金払い（仕入確定と同時に自動登録）',automatic_payment_key,
        auth.uid(),auth.uid()
      )
      on conflict (source_key) do update set
        payable_id = excluded.payable_id,
        payment_date = excluded.payment_date,
        amount_jpy = excluded.amount_jpy,
        bank_fee_jpy = 0,
        reference_no = excluded.reference_no,
        memo = excluded.memo,
        updated_by = auth.uid();
    else
      delete from public.accounts_payable_payments
      where source_key = automatic_payment_key;
    end if;
  end loop;

  return processed;
end;
$$;

insert into public.accounts_payable_supplier_profiles (
  supplier_code,payment_mode,closing_day,payment_month_offset,payment_day,memo
)
select supplier.supplier_code,'cash_on_entry',31,0,31,'都度現金払い'
from public.supplier_master supplier
where btrim(supplier.supplier_code) = '1'
on conflict (supplier_code) do update set
  payment_mode = 'cash_on_entry',
  payment_month_offset = 0,
  updated_at = now();

do $$
begin
  if public.accounts_payable_due_date(date '2026-08-15',15::smallint,1::smallint,15::smallint) <> date '2026-09-15' then
    raise exception '15-day closing due date check failed for the closing date.';
  end if;
  if public.accounts_payable_due_date(date '2026-08-16',15::smallint,1::smallint,15::smallint) <> date '2026-10-15' then
    raise exception '15-day closing due date check failed after the closing date.';
  end if;
  if public.accounts_payable_due_date(date '2026-08-31',31::smallint,1::smallint,31::smallint) <> date '2026-09-30' then
    raise exception 'Month-end due date check failed.';
  end if;
end;
$$;

revoke all on function public.accounts_payable_due_date(date,smallint,smallint,smallint)
  from public,anon;
grant execute on function public.accounts_payable_due_date(date,smallint,smallint,smallint)
  to authenticated;

revoke all on function public.sync_confirmed_purchases_to_payables()
  from public,anon;
grant execute on function public.sync_confirmed_purchases_to_payables()
  to authenticated;

notify pgrst, 'reload schema';

commit;
