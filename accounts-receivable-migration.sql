-- 売掛管理の初期テーブルです。
-- Supabase Dashboard > SQL Editor で1回実行してください。

create extension if not exists pgcrypto;

create table if not exists public.accounts_receivable (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  source_type text not null default 'manual'
    check (source_type in ('sales', 'opening', 'manual', 'adjustment')),
  source_session_id uuid references public.work_sessions(id) on delete set null,
  importer_code text not null,
  importer_name text,
  customer_code text,
  customer_name text,
  customer_names jsonb not null default '[]'::jsonb,
  invoice_no text,
  invoice_date date not null,
  due_date date,
  currency text not null default 'JPY',
  foreign_amount numeric(18, 4),
  exchange_rate numeric(18, 6),
  net_sales_jpy numeric(18, 2) not null default 0,
  shipping_amount_jpy numeric(18, 2) not null default 0,
  adjustment_amount_jpy numeric(18, 2) not null default 0,
  amount_jpy numeric(18, 2) not null default 0,
  freee_excluded boolean not null default false,
  freee_exported_at timestamptz,
  freee_export_batch text,
  memo text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.accounts_receivable_payments (
  id uuid primary key default gen_random_uuid(),
  receivable_id uuid not null
    references public.accounts_receivable(id) on delete cascade,
  payment_date date not null,
  currency text not null default 'JPY',
  foreign_amount numeric(18, 4),
  exchange_rate numeric(18, 6),
  amount_jpy numeric(18, 2) not null check (amount_jpy > 0),
  bank_fee_jpy numeric(18, 2) not null default 0 check (bank_fee_jpy >= 0),
  fx_gain_loss_jpy numeric(18, 2) not null default 0,
  reference_no text,
  memo text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create sequence if not exists public.accounts_receivable_statement_no_seq
  start with 179;

create table if not exists public.accounts_receivable_statement_profiles (
  importer_code text primary key,
  customer_name text not null default '',
  address_text text not null default '',
  phone text not null default '',
  currency text not null default 'JPY',
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.accounts_receivable_statements (
  id uuid primary key default gen_random_uuid(),
  statement_no bigint not null unique
    default nextval('public.accounts_receivable_statement_no_seq'),
  importer_code text not null,
  period_from date not null,
  period_to date not null,
  carryover_amount_jpy numeric(18, 2) not null default 0,
  charge_amount_jpy numeric(18, 2) not null default 0,
  payment_amount_jpy numeric(18, 2) not null default 0,
  total_amount_jpy numeric(18, 2) not null default 0,
  snapshot jsonb not null default '{}'::jsonb,
  issued_by uuid references auth.users(id) on delete set null,
  issued_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(importer_code, period_from, period_to)
);

create index if not exists idx_accounts_receivable_invoice_date
  on public.accounts_receivable(invoice_date desc);
create index if not exists idx_accounts_receivable_importer
  on public.accounts_receivable(importer_code, invoice_date desc);
create index if not exists idx_accounts_receivable_due_date
  on public.accounts_receivable(due_date);
create index if not exists idx_accounts_receivable_source_session
  on public.accounts_receivable(source_session_id);
create index if not exists idx_accounts_receivable_payments_receivable
  on public.accounts_receivable_payments(receivable_id, payment_date);
create index if not exists idx_accounts_receivable_statements_period
  on public.accounts_receivable_statements(period_from, period_to, importer_code);

create or replace function public.set_accounts_receivable_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_accounts_receivable_updated_at
  on public.accounts_receivable;
create trigger trg_accounts_receivable_updated_at
before update on public.accounts_receivable
for each row execute function public.set_accounts_receivable_updated_at();

drop trigger if exists trg_accounts_receivable_payments_updated_at
  on public.accounts_receivable_payments;
create trigger trg_accounts_receivable_payments_updated_at
before update on public.accounts_receivable_payments
for each row execute function public.set_accounts_receivable_updated_at();

drop trigger if exists trg_accounts_receivable_statement_profiles_updated_at
  on public.accounts_receivable_statement_profiles;
create trigger trg_accounts_receivable_statement_profiles_updated_at
before update on public.accounts_receivable_statement_profiles
for each row execute function public.set_accounts_receivable_updated_at();

drop trigger if exists trg_accounts_receivable_statements_updated_at
  on public.accounts_receivable_statements;
create trigger trg_accounts_receivable_statements_updated_at
before update on public.accounts_receivable_statements
for each row execute function public.set_accounts_receivable_updated_at();

alter table public.accounts_receivable enable row level security;
alter table public.accounts_receivable_payments enable row level security;
alter table public.accounts_receivable_statement_profiles enable row level security;
alter table public.accounts_receivable_statements enable row level security;

drop policy if exists "authenticated can read accounts receivable"
  on public.accounts_receivable;
create policy "authenticated can read accounts receivable"
on public.accounts_receivable for select to authenticated
using (true);

drop policy if exists "authenticated can insert accounts receivable"
  on public.accounts_receivable;
create policy "authenticated can insert accounts receivable"
on public.accounts_receivable for insert to authenticated
with check (
  source_type <> 'opening'
  or public.is_master_admin()
);

drop policy if exists "authenticated can update accounts receivable"
  on public.accounts_receivable;
create policy "authenticated can update accounts receivable"
on public.accounts_receivable for update to authenticated
using (true)
with check (
  source_type <> 'opening'
  or public.is_master_admin()
);

drop policy if exists "admins can delete accounts receivable"
  on public.accounts_receivable;
create policy "admins can delete accounts receivable"
on public.accounts_receivable for delete to authenticated
using (public.is_master_admin());

drop policy if exists "authenticated can read receivable payments"
  on public.accounts_receivable_payments;
create policy "authenticated can read receivable payments"
on public.accounts_receivable_payments for select to authenticated
using (true);

drop policy if exists "authenticated can insert receivable payments"
  on public.accounts_receivable_payments;
create policy "authenticated can insert receivable payments"
on public.accounts_receivable_payments for insert to authenticated
with check (true);

drop policy if exists "authenticated can update receivable payments"
  on public.accounts_receivable_payments;
create policy "authenticated can update receivable payments"
on public.accounts_receivable_payments for update to authenticated
using (true) with check (true);

drop policy if exists "admins can delete receivable payments"
  on public.accounts_receivable_payments;
create policy "admins can delete receivable payments"
on public.accounts_receivable_payments for delete to authenticated
using (public.is_master_admin());

drop policy if exists "authenticated can read statement profiles"
  on public.accounts_receivable_statement_profiles;
create policy "authenticated can read statement profiles"
on public.accounts_receivable_statement_profiles for select to authenticated
using (true);

drop policy if exists "authenticated can insert statement profiles"
  on public.accounts_receivable_statement_profiles;
create policy "authenticated can insert statement profiles"
on public.accounts_receivable_statement_profiles for insert to authenticated
with check (true);

drop policy if exists "authenticated can update statement profiles"
  on public.accounts_receivable_statement_profiles;
create policy "authenticated can update statement profiles"
on public.accounts_receivable_statement_profiles for update to authenticated
using (true) with check (true);

drop policy if exists "admins can delete statement profiles"
  on public.accounts_receivable_statement_profiles;
create policy "admins can delete statement profiles"
on public.accounts_receivable_statement_profiles for delete to authenticated
using (public.is_master_admin());

drop policy if exists "authenticated can read statements"
  on public.accounts_receivable_statements;
create policy "authenticated can read statements"
on public.accounts_receivable_statements for select to authenticated
using (true);

drop policy if exists "authenticated can insert statements"
  on public.accounts_receivable_statements;
create policy "authenticated can insert statements"
on public.accounts_receivable_statements for insert to authenticated
with check (true);

drop policy if exists "authenticated can update statements"
  on public.accounts_receivable_statements;
create policy "authenticated can update statements"
on public.accounts_receivable_statements for update to authenticated
using (true) with check (true);

drop policy if exists "admins can delete statements"
  on public.accounts_receivable_statements;
create policy "admins can delete statements"
on public.accounts_receivable_statements for delete to authenticated
using (public.is_master_admin());

grant select, insert, update, delete
  on public.accounts_receivable to authenticated;
grant select, insert, update, delete
  on public.accounts_receivable_payments to authenticated;
grant select, insert, update, delete
  on public.accounts_receivable_statement_profiles to authenticated;
grant select, insert, update, delete
  on public.accounts_receivable_statements to authenticated;
grant usage, select
  on sequence public.accounts_receivable_statement_no_seq to authenticated;

notify pgrst, 'reload schema';

