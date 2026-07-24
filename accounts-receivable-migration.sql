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
  closing_day smallint not null default 31
    check (closing_day between 1 and 31),
  payment_month_offset smallint not null default 1
    check (payment_month_offset between 0 and 12),
  payment_day smallint not null default 31
    check (payment_day between 1 and 31),
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

alter table public.accounts_receivable_statement_profiles
  add column if not exists closing_day smallint not null default 31
    check (closing_day between 1 and 31);
alter table public.accounts_receivable_statement_profiles
  add column if not exists payment_month_offset smallint not null default 1
    check (payment_month_offset between 0 and 12);
alter table public.accounts_receivable_statement_profiles
  add column if not exists payment_day smallint not null default 31
    check (payment_day between 1 and 31);

create table if not exists public.accounts_receivable_closings (
  id uuid primary key default gen_random_uuid(),
  importer_code text not null,
  period_from date not null,
  period_to date not null,
  due_date date not null,
  statement_id uuid references public.accounts_receivable_statements(id)
    on delete set null,
  carryover_amount_jpy numeric(18, 2) not null default 0,
  charge_amount_jpy numeric(18, 2) not null default 0,
  payment_amount_jpy numeric(18, 2) not null default 0,
  closing_balance_jpy numeric(18, 2) not null default 0,
  status text not null default 'closed'
    check (status in ('closed', 'reopened')),
  snapshot jsonb not null default '{}'::jsonb,
  closed_by uuid references auth.users(id) on delete set null,
  closed_at timestamptz not null default now(),
  reopened_by uuid references auth.users(id) on delete set null,
  reopened_at timestamptz,
  reopen_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(importer_code, period_from, period_to),
  check (period_from <= period_to)
);

alter table public.accounts_receivable
  add column if not exists closing_id uuid
    references public.accounts_receivable_closings(id) on delete set null;
alter table public.accounts_receivable_payments
  add column if not exists closing_id uuid
    references public.accounts_receivable_closings(id) on delete set null;

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
create index if not exists idx_accounts_receivable_closing_id
  on public.accounts_receivable(closing_id);
create index if not exists idx_accounts_receivable_payments_closing_id
  on public.accounts_receivable_payments(closing_id);
create index if not exists idx_accounts_receivable_closings_period
  on public.accounts_receivable_closings(importer_code, period_to desc);

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

drop trigger if exists trg_accounts_receivable_closings_updated_at
  on public.accounts_receivable_closings;
create trigger trg_accounts_receivable_closings_updated_at
before update on public.accounts_receivable_closings
for each row execute function public.set_accounts_receivable_updated_at();

create or replace function public.protect_closed_receivable()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  active_closing_id uuid;
begin
  if tg_op = 'DELETE' then
    if old.closing_id is not null and exists (
      select 1
      from public.accounts_receivable_closings c
      where c.id = old.closing_id
        and c.status = 'closed'
    ) then
      raise exception '請求締め済みの売掛は変更できません。先に締め解除してください。';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE'
     and old.closing_id is not null
     and exists (
       select 1
       from public.accounts_receivable_closings c
       where c.id = old.closing_id
         and c.status = 'closed'
     ) then
    raise exception '請求締め済みの売掛は変更できません。先に締め解除してください。';
  end if;

  select c.id
    into active_closing_id
  from public.accounts_receivable_closings c
  where upper(trim(c.importer_code)) = upper(trim(new.importer_code))
    and c.status = 'closed'
    and new.invoice_date between c.period_from and c.period_to
  order by c.closed_at desc
  limit 1;

  if active_closing_id is not null
     and not (
       tg_op = 'UPDATE'
       and old.closing_id is null
       and new.closing_id = active_closing_id
     ) then
    raise exception '指定日の請求は締め済みです。先に締め解除してください。';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_protect_closed_receivable
  on public.accounts_receivable;
create trigger trg_protect_closed_receivable
before insert or update or delete on public.accounts_receivable
for each row execute function public.protect_closed_receivable();

create or replace function public.protect_closed_receivable_payment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  target_importer_code text;
  active_closing_id uuid;
begin
  if tg_op = 'DELETE' then
    if old.closing_id is not null and exists (
      select 1
      from public.accounts_receivable_closings c
      where c.id = old.closing_id
        and c.status = 'closed'
    ) then
      raise exception '請求締め済みの入金は変更できません。先に締め解除してください。';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE'
     and old.closing_id is not null
     and exists (
       select 1
       from public.accounts_receivable_closings c
       where c.id = old.closing_id
         and c.status = 'closed'
     ) then
    raise exception '請求締め済みの入金は変更できません。先に締め解除してください。';
  end if;

  select r.importer_code
    into target_importer_code
  from public.accounts_receivable r
  where r.id = new.receivable_id;

  select c.id
    into active_closing_id
  from public.accounts_receivable_closings c
  where upper(trim(c.importer_code)) = upper(trim(target_importer_code))
    and c.status = 'closed'
    and new.payment_date between c.period_from and c.period_to
  order by c.closed_at desc
  limit 1;

  if active_closing_id is not null
     and not (
       tg_op = 'UPDATE'
       and old.closing_id is null
       and new.closing_id = active_closing_id
     ) then
    raise exception '指定日の入金は締め済みです。先に締め解除してください。';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_protect_closed_receivable_payment
  on public.accounts_receivable_payments;
create trigger trg_protect_closed_receivable_payment
before insert or update or delete on public.accounts_receivable_payments
for each row execute function public.protect_closed_receivable_payment();

alter table public.accounts_receivable enable row level security;
alter table public.accounts_receivable_payments enable row level security;
alter table public.accounts_receivable_statement_profiles enable row level security;
alter table public.accounts_receivable_statements enable row level security;
alter table public.accounts_receivable_closings enable row level security;

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

drop policy if exists "authenticated can read receivable closings"
  on public.accounts_receivable_closings;
create policy "authenticated can read receivable closings"
on public.accounts_receivable_closings for select to authenticated
using (true);

drop policy if exists "authenticated can insert receivable closings"
  on public.accounts_receivable_closings;
create policy "authenticated can insert receivable closings"
on public.accounts_receivable_closings for insert to authenticated
with check (closed_by = auth.uid());

drop policy if exists "authenticated can reclose reopened periods"
  on public.accounts_receivable_closings;
create policy "authenticated can reclose reopened periods"
on public.accounts_receivable_closings for update to authenticated
using (status = 'reopened')
with check (status = 'closed' and closed_by = auth.uid());

drop policy if exists "admins can update receivable closings"
  on public.accounts_receivable_closings;
create policy "admins can update receivable closings"
on public.accounts_receivable_closings for update to authenticated
using (public.is_master_admin())
with check (public.is_master_admin());

drop policy if exists "admins can delete receivable closings"
  on public.accounts_receivable_closings;
create policy "admins can delete receivable closings"
on public.accounts_receivable_closings for delete to authenticated
using (public.is_master_admin());

create or replace function public.close_accounts_receivable_period(
  p_importer_code text,
  p_period_from date,
  p_period_to date,
  p_due_date date,
  p_statement_id uuid,
  p_carryover_amount_jpy numeric,
  p_charge_amount_jpy numeric,
  p_payment_amount_jpy numeric,
  p_closing_balance_jpy numeric,
  p_snapshot jsonb
)
returns public.accounts_receivable_closings
language plpgsql
security invoker
set search_path = public
as $$
declare
  closing_row public.accounts_receivable_closings;
  normalized_importer_code text := upper(trim(p_importer_code));
begin
  if auth.uid() is null then
    raise exception 'ログインしてください。';
  end if;
  if normalized_importer_code = '' then
    raise exception '輸入社コードを指定してください。';
  end if;
  if p_period_from is null or p_period_to is null or p_period_from > p_period_to then
    raise exception '請求締め期間が正しくありません。';
  end if;
  if p_due_date is null then
    raise exception '支払期限を指定してください。';
  end if;
  if exists (
    select 1
    from public.accounts_receivable_closings c
    where upper(trim(c.importer_code)) = normalized_importer_code
      and c.status = 'closed'
      and daterange(c.period_from, c.period_to, '[]')
        && daterange(p_period_from, p_period_to, '[]')
  ) then
    raise exception '指定期間はすでに請求締め済みです。';
  end if;

  insert into public.accounts_receivable_closings (
    importer_code,
    period_from,
    period_to,
    due_date,
    statement_id,
    carryover_amount_jpy,
    charge_amount_jpy,
    payment_amount_jpy,
    closing_balance_jpy,
    status,
    snapshot,
    closed_by,
    closed_at,
    reopened_by,
    reopened_at,
    reopen_reason
  )
  values (
    normalized_importer_code,
    p_period_from,
    p_period_to,
    p_due_date,
    p_statement_id,
    coalesce(p_carryover_amount_jpy, 0),
    coalesce(p_charge_amount_jpy, 0),
    coalesce(p_payment_amount_jpy, 0),
    coalesce(p_closing_balance_jpy, 0),
    'closed',
    coalesce(p_snapshot, '{}'::jsonb),
    auth.uid(),
    now(),
    null,
    null,
    null
  )
  on conflict (importer_code, period_from, period_to)
  do update set
    due_date = excluded.due_date,
    statement_id = excluded.statement_id,
    carryover_amount_jpy = excluded.carryover_amount_jpy,
    charge_amount_jpy = excluded.charge_amount_jpy,
    payment_amount_jpy = excluded.payment_amount_jpy,
    closing_balance_jpy = excluded.closing_balance_jpy,
    status = 'closed',
    snapshot = excluded.snapshot,
    closed_by = auth.uid(),
    closed_at = now(),
    reopened_by = null,
    reopened_at = null,
    reopen_reason = null
  returning * into closing_row;

  update public.accounts_receivable
  set closing_id = closing_row.id,
      due_date = p_due_date,
      updated_by = auth.uid()
  where upper(trim(importer_code)) = normalized_importer_code
    and invoice_date between p_period_from and p_period_to
    and closing_id is null;

  update public.accounts_receivable_payments p
  set closing_id = closing_row.id,
      updated_by = auth.uid()
  from public.accounts_receivable r
  where p.receivable_id = r.id
    and upper(trim(r.importer_code)) = normalized_importer_code
    and p.payment_date between p_period_from and p_period_to
    and p.closing_id is null;

  return closing_row;
end;
$$;

create or replace function public.reopen_accounts_receivable_period(
  p_closing_id uuid,
  p_reason text
)
returns public.accounts_receivable_closings
language plpgsql
security invoker
set search_path = public
as $$
declare
  closing_row public.accounts_receivable_closings;
begin
  if not public.is_master_admin() then
    raise exception '請求締めを解除できるのは管理者のみです。';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception '締め解除の理由を入力してください。';
  end if;

  update public.accounts_receivable_closings
  set status = 'reopened',
      reopened_by = auth.uid(),
      reopened_at = now(),
      reopen_reason = trim(p_reason)
  where id = p_closing_id
    and status = 'closed'
  returning * into closing_row;

  if closing_row.id is null then
    raise exception '解除する請求締めが見つかりません。';
  end if;

  update public.accounts_receivable_payments
  set closing_id = null,
      updated_by = auth.uid()
  where closing_id = p_closing_id;

  update public.accounts_receivable
  set closing_id = null,
      updated_by = auth.uid()
  where closing_id = p_closing_id;

  return closing_row;
end;
$$;

grant select, insert, update, delete
  on public.accounts_receivable to authenticated;
grant select, insert, update, delete
  on public.accounts_receivable_payments to authenticated;
grant select, insert, update, delete
  on public.accounts_receivable_statement_profiles to authenticated;
grant select, insert, update, delete
  on public.accounts_receivable_statements to authenticated;
grant select, insert, update, delete
  on public.accounts_receivable_closings to authenticated;
grant usage, select
  on sequence public.accounts_receivable_statement_no_seq to authenticated;
revoke all on function public.close_accounts_receivable_period(
  text, date, date, date, uuid, numeric, numeric, numeric, numeric, jsonb
) from public, anon;
grant execute on function public.close_accounts_receivable_period(
  text, date, date, date, uuid, numeric, numeric, numeric, numeric, jsonb
) to authenticated;
revoke all on function public.reopen_accounts_receivable_period(
  uuid, text
) from public, anon;
grant execute on function public.reopen_accounts_receivable_period(
  uuid, text
) to authenticated;

notify pgrst, 'reload schema';
