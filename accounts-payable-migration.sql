-- Accounts payable, supplier payment terms, and purchase receipt linkage.
-- Run after site-partner-purchase-migration.sql.

begin;

create extension if not exists pgcrypto;

create table if not exists public.accounts_payable_supplier_profiles (
  supplier_code text primary key
    references public.supplier_master(supplier_code) on delete restrict,
  closing_day smallint not null default 31
    check (closing_day between 1 and 31),
  payment_month_offset smallint not null default 1
    check (payment_month_offset between 0 and 12),
  payment_day smallint not null default 31
    check (payment_day between 1 and 31),
  memo text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.accounts_payable (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique default gen_random_uuid()::text,
  source_type text not null default 'purchase'
    check (source_type in ('purchase','opening','manual','adjustment')),
  supplier_code text not null
    references public.supplier_master(supplier_code) on delete restrict,
  supplier_name text,
  invoice_no text,
  invoice_date date not null,
  period_from date,
  period_to date,
  due_date date,
  subtotal_jpy numeric(18,2) not null default 0,
  shipping_amount_jpy numeric(18,2) not null default 0,
  other_amount_jpy numeric(18,2) not null default 0,
  tax_amount_jpy numeric(18,2) not null default 0,
  adjustment_amount_jpy numeric(18,2) not null default 0,
  amount_jpy numeric(18,2) not null default 0,
  freee_excluded boolean not null default false,
  freee_exported_at timestamptz,
  freee_export_batch text,
  memo text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_from is null or period_to is null or period_from <= period_to)
);

create unique index if not exists uq_accounts_payable_supplier_invoice
  on public.accounts_payable(supplier_code, invoice_no)
  where invoice_no is not null and btrim(invoice_no) <> '';

create table if not exists public.accounts_payable_payments (
  id uuid primary key default gen_random_uuid(),
  payable_id uuid not null
    references public.accounts_payable(id) on delete cascade,
  payment_date date not null,
  amount_jpy numeric(18,2) not null check (amount_jpy > 0),
  bank_fee_jpy numeric(18,2) not null default 0 check (bank_fee_jpy >= 0),
  reference_no text,
  memo text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.purchase_receipts
  add column if not exists accounts_payable_id uuid
    references public.accounts_payable(id) on delete set null;

create index if not exists idx_accounts_payable_invoice_date
  on public.accounts_payable(invoice_date desc);
create index if not exists idx_accounts_payable_supplier
  on public.accounts_payable(supplier_code, invoice_date desc);
create index if not exists idx_accounts_payable_due_date
  on public.accounts_payable(due_date);
create index if not exists idx_accounts_payable_payments_payable
  on public.accounts_payable_payments(payable_id, payment_date desc);
create index if not exists idx_purchase_receipts_accounts_payable
  on public.purchase_receipts(accounts_payable_id);

create or replace function public.touch_accounts_payable_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_accounts_payable_profile_touch
  on public.accounts_payable_supplier_profiles;
create trigger trg_accounts_payable_profile_touch
before update on public.accounts_payable_supplier_profiles
for each row execute function public.touch_accounts_payable_updated_at();

drop trigger if exists trg_accounts_payable_touch
  on public.accounts_payable;
create trigger trg_accounts_payable_touch
before update on public.accounts_payable
for each row execute function public.touch_accounts_payable_updated_at();

drop trigger if exists trg_accounts_payable_payment_touch
  on public.accounts_payable_payments;
create trigger trg_accounts_payable_payment_touch
before update on public.accounts_payable_payments
for each row execute function public.touch_accounts_payable_updated_at();

create or replace function public.accounts_payable_due_date(
  p_invoice_date date,
  p_payment_month_offset smallint,
  p_payment_day smallint
)
returns date
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  target_month date;
  target_last_day date;
  target_day integer;
begin
  if p_invoice_date is null then return null; end if;
  target_month := (
    date_trunc('month', p_invoice_date)::date
    + make_interval(months => greatest(coalesce(p_payment_month_offset,1),0)::integer)
  )::date;
  target_last_day := (target_month + interval '1 month - 1 day')::date;
  target_day := least(greatest(coalesce(p_payment_day,31),1), extract(day from target_last_day)::integer);
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
  payable_id uuid;
  payment_month_offset smallint;
  payment_day smallint;
  processed integer := 0;
begin
  if not public.is_internal_user() then
    raise exception 'Internal access is required.';
  end if;

  for grouped in
    select
      receipt.supplier_code,
      max(coalesce(receipt.supplier_name_snapshot, supplier.supplier_name)) as supplier_name,
      btrim(receipt.supplier_invoice_no) as invoice_no,
      coalesce(max(receipt.invoice_date), max(receipt.purchase_date)) as invoice_date,
      min(receipt.purchase_date) as period_from,
      max(receipt.purchase_date) as period_to,
      array_agg(receipt.id order by receipt.purchase_date, receipt.created_at) as receipt_ids
    from public.purchase_receipts receipt
    join public.supplier_master supplier
      on supplier.supplier_code = receipt.supplier_code
    where receipt.status = 'confirmed'
      and receipt.accounts_payable_id is null
      and nullif(btrim(receipt.supplier_invoice_no),'') is not null
    group by receipt.supplier_code, btrim(receipt.supplier_invoice_no)
    order by min(receipt.purchase_date), receipt.supplier_code
  loop
    select
      coalesce(profile.payment_month_offset,1),
      coalesce(profile.payment_day,31)
    into payment_month_offset, payment_day
    from (select 1) seed
    left join public.accounts_payable_supplier_profiles profile
      on profile.supplier_code = grouped.supplier_code;

    insert into public.accounts_payable (
      source_key, source_type, supplier_code, supplier_name, invoice_no,
      invoice_date, period_from, period_to, due_date, memo,
      created_by, updated_by
    ) values (
      'purchase:' || grouped.supplier_code || ':' || grouped.invoice_no,
      'purchase', grouped.supplier_code, grouped.supplier_name, grouped.invoice_no,
      grouped.invoice_date, grouped.period_from, grouped.period_to,
      public.accounts_payable_due_date(grouped.invoice_date,payment_month_offset,payment_day),
      '仕入確定データから自動作成', auth.uid(), auth.uid()
    )
    on conflict (supplier_code, invoice_no)
      where invoice_no is not null and btrim(invoice_no) <> ''
    do update set
      supplier_name = excluded.supplier_name,
      invoice_date = excluded.invoice_date,
      period_from = least(public.accounts_payable.period_from, excluded.period_from),
      period_to = greatest(public.accounts_payable.period_to, excluded.period_to),
      due_date = coalesce(public.accounts_payable.due_date, excluded.due_date),
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

  return processed;
end;
$$;

alter table public.accounts_payable_supplier_profiles enable row level security;
alter table public.accounts_payable enable row level security;
alter table public.accounts_payable_payments enable row level security;

drop policy if exists "internal read payable supplier profiles"
  on public.accounts_payable_supplier_profiles;
create policy "internal read payable supplier profiles"
on public.accounts_payable_supplier_profiles for select to authenticated
using (public.is_internal_user());

drop policy if exists "admins manage payable supplier profiles"
  on public.accounts_payable_supplier_profiles;
create policy "admins manage payable supplier profiles"
on public.accounts_payable_supplier_profiles for all to authenticated
using (public.is_master_admin())
with check (public.is_master_admin());

drop policy if exists "internal read accounts payable"
  on public.accounts_payable;
create policy "internal read accounts payable"
on public.accounts_payable for select to authenticated
using (public.is_internal_user());

drop policy if exists "internal insert accounts payable"
  on public.accounts_payable;
create policy "internal insert accounts payable"
on public.accounts_payable for insert to authenticated
with check (
  public.is_internal_user()
  and (source_type <> 'opening' or public.is_master_admin())
);

drop policy if exists "internal update accounts payable"
  on public.accounts_payable;
create policy "internal update accounts payable"
on public.accounts_payable for update to authenticated
using (public.is_internal_user())
with check (
  public.is_internal_user()
  and (source_type <> 'opening' or public.is_master_admin())
);

drop policy if exists "admins delete accounts payable"
  on public.accounts_payable;
create policy "admins delete accounts payable"
on public.accounts_payable for delete to authenticated
using (public.is_master_admin());

drop policy if exists "internal read payable payments"
  on public.accounts_payable_payments;
create policy "internal read payable payments"
on public.accounts_payable_payments for select to authenticated
using (public.is_internal_user());

drop policy if exists "internal insert payable payments"
  on public.accounts_payable_payments;
create policy "internal insert payable payments"
on public.accounts_payable_payments for insert to authenticated
with check (public.is_internal_user());

drop policy if exists "internal update payable payments"
  on public.accounts_payable_payments;
create policy "internal update payable payments"
on public.accounts_payable_payments for update to authenticated
using (public.is_internal_user())
with check (public.is_internal_user());

drop policy if exists "admins delete payable payments"
  on public.accounts_payable_payments;
create policy "admins delete payable payments"
on public.accounts_payable_payments for delete to authenticated
using (public.is_master_admin());

grant select, insert, update, delete
  on public.accounts_payable_supplier_profiles to authenticated;
grant select, insert, update, delete
  on public.accounts_payable to authenticated;
grant select, insert, update, delete
  on public.accounts_payable_payments to authenticated;

revoke all on function public.sync_confirmed_purchases_to_payables() from public;
grant execute on function public.sync_confirmed_purchases_to_payables() to authenticated;
grant execute on function public.accounts_payable_due_date(date,smallint,smallint) to authenticated;

commit;
