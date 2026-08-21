-- Accounts payable closing, period locking, and reopening.
-- Run after accounts-payable-migration.sql.

begin;

create table if not exists public.accounts_payable_closings (
  id uuid primary key default gen_random_uuid(),
  supplier_code text not null
    references public.supplier_master(supplier_code) on delete restrict,
  period_from date not null,
  period_to date not null,
  due_date date not null,
  opening_balance_jpy numeric(18,2) not null default 0,
  purchase_amount_jpy numeric(18,2) not null default 0,
  payment_amount_jpy numeric(18,2) not null default 0,
  closing_balance_jpy numeric(18,2) not null default 0,
  status text not null default 'closed'
    check (status in ('closed','reopened')),
  snapshot jsonb not null default '{}'::jsonb,
  closed_by uuid references auth.users(id) on delete set null,
  closed_at timestamptz not null default now(),
  reopened_by uuid references auth.users(id) on delete set null,
  reopened_at timestamptz,
  reopen_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(supplier_code, period_from, period_to),
  check (period_from <= period_to)
);

alter table public.accounts_payable
  add column if not exists closing_id uuid
    references public.accounts_payable_closings(id) on delete set null;
alter table public.accounts_payable_payments
  add column if not exists closing_id uuid
    references public.accounts_payable_closings(id) on delete set null;

create index if not exists idx_accounts_payable_closing_id
  on public.accounts_payable(closing_id);
create index if not exists idx_accounts_payable_payments_closing_id
  on public.accounts_payable_payments(closing_id);
create index if not exists idx_accounts_payable_closings_period
  on public.accounts_payable_closings(supplier_code, period_to desc);

drop trigger if exists trg_accounts_payable_closing_touch
  on public.accounts_payable_closings;
create trigger trg_accounts_payable_closing_touch
before update on public.accounts_payable_closings
for each row execute function public.touch_accounts_payable_updated_at();

create or replace function public.protect_closed_payable()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  active_closing_id uuid;
begin
  if tg_op = 'DELETE' then
    if old.closing_id is not null and exists (
      select 1 from public.accounts_payable_closings c
      where c.id = old.closing_id and c.status = 'closed'
    ) then
      raise exception '買掛締め済みの明細は変更できません。先に締め解除してください。';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE'
     and old.closing_id is not null
     and exists (
       select 1 from public.accounts_payable_closings c
       where c.id = old.closing_id and c.status = 'closed'
     ) then
    raise exception '買掛締め済みの明細は変更できません。先に締め解除してください。';
  end if;

  select c.id into active_closing_id
  from public.accounts_payable_closings c
  where upper(trim(c.supplier_code)) = upper(trim(new.supplier_code))
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
    raise exception '指定日の買掛は締め済みです。先に締め解除してください。';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_protect_closed_payable
  on public.accounts_payable;
create trigger trg_protect_closed_payable
before insert or update or delete on public.accounts_payable
for each row execute function public.protect_closed_payable();

create or replace function public.protect_closed_payable_payment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  target_supplier_code text;
  active_closing_id uuid;
begin
  if tg_op = 'DELETE' then
    if old.closing_id is not null and exists (
      select 1 from public.accounts_payable_closings c
      where c.id = old.closing_id and c.status = 'closed'
    ) then
      raise exception '買掛締め済みの支払は変更できません。先に締め解除してください。';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE'
     and old.closing_id is not null
     and exists (
       select 1 from public.accounts_payable_closings c
       where c.id = old.closing_id and c.status = 'closed'
     ) then
    raise exception '買掛締め済みの支払は変更できません。先に締め解除してください。';
  end if;

  select p.supplier_code into target_supplier_code
  from public.accounts_payable p
  where p.id = new.payable_id;

  select c.id into active_closing_id
  from public.accounts_payable_closings c
  where upper(trim(c.supplier_code)) = upper(trim(target_supplier_code))
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
    raise exception '指定日の支払は締め済みです。先に締め解除してください。';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_protect_closed_payable_payment
  on public.accounts_payable_payments;
create trigger trg_protect_closed_payable_payment
before insert or update or delete on public.accounts_payable_payments
for each row execute function public.protect_closed_payable_payment();

alter table public.accounts_payable_closings enable row level security;

do $$
begin
  if to_regprocedure('public.log_business_audit_event()') is not null then
    drop trigger if exists trg_business_audit on public.accounts_payable_closings;
    create trigger trg_business_audit
    after insert or update or delete on public.accounts_payable_closings
    for each row execute function public.log_business_audit_event();
  end if;
end $$;

drop policy if exists "internal read payable closings"
  on public.accounts_payable_closings;
create policy "internal read payable closings"
on public.accounts_payable_closings for select to authenticated
using (public.is_internal_user());

drop policy if exists "internal insert payable closings"
  on public.accounts_payable_closings;
create policy "internal insert payable closings"
on public.accounts_payable_closings for insert to authenticated
with check (public.is_internal_user() and closed_by = auth.uid());

drop policy if exists "internal reclose payable closings"
  on public.accounts_payable_closings;
create policy "internal reclose payable closings"
on public.accounts_payable_closings for update to authenticated
using (public.is_internal_user() and status = 'reopened')
with check (public.is_internal_user() and status = 'closed' and closed_by = auth.uid());

drop policy if exists "admins update payable closings"
  on public.accounts_payable_closings;
create policy "admins update payable closings"
on public.accounts_payable_closings for update to authenticated
using (public.is_master_admin())
with check (public.is_master_admin());

drop policy if exists "admins delete payable closings"
  on public.accounts_payable_closings;
create policy "admins delete payable closings"
on public.accounts_payable_closings for delete to authenticated
using (public.is_master_admin());

create or replace function public.close_accounts_payable_period(
  p_supplier_code text,
  p_period_from date,
  p_period_to date,
  p_due_date date,
  p_opening_balance_jpy numeric,
  p_purchase_amount_jpy numeric,
  p_payment_amount_jpy numeric,
  p_closing_balance_jpy numeric,
  p_snapshot jsonb
)
returns public.accounts_payable_closings
language plpgsql
security invoker
set search_path = public
as $$
declare
  closing_row public.accounts_payable_closings;
  normalized_supplier_code text := trim(p_supplier_code);
begin
  if auth.uid() is null or not public.is_internal_user() then
    raise exception 'ログインしてください。';
  end if;
  if normalized_supplier_code = '' then
    raise exception '仕入先コードを指定してください。';
  end if;
  if p_period_from is null or p_period_to is null or p_period_from > p_period_to then
    raise exception '買掛締め期間が正しくありません。';
  end if;
  if p_due_date is null then
    raise exception '支払期限を指定してください。';
  end if;
  if exists (
    select 1 from public.accounts_payable_closings c
    where upper(trim(c.supplier_code)) = upper(normalized_supplier_code)
      and c.status = 'closed'
      and daterange(c.period_from, c.period_to, '[]')
        && daterange(p_period_from, p_period_to, '[]')
  ) then
    raise exception '指定期間はすでに買掛締め済みです。';
  end if;

  insert into public.accounts_payable_closings (
    supplier_code, period_from, period_to, due_date,
    opening_balance_jpy, purchase_amount_jpy, payment_amount_jpy,
    closing_balance_jpy, status, snapshot, closed_by, closed_at,
    reopened_by, reopened_at, reopen_reason
  ) values (
    normalized_supplier_code, p_period_from, p_period_to, p_due_date,
    coalesce(p_opening_balance_jpy,0), coalesce(p_purchase_amount_jpy,0),
    coalesce(p_payment_amount_jpy,0), coalesce(p_closing_balance_jpy,0),
    'closed', coalesce(p_snapshot,'{}'::jsonb), auth.uid(), now(),
    null, null, null
  )
  on conflict (supplier_code, period_from, period_to)
  do update set
    due_date = excluded.due_date,
    opening_balance_jpy = excluded.opening_balance_jpy,
    purchase_amount_jpy = excluded.purchase_amount_jpy,
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

  update public.accounts_payable
  set closing_id = closing_row.id,
      due_date = case
        when invoice_date between p_period_from and p_period_to then p_due_date
        else due_date
      end,
      updated_by = auth.uid()
  where upper(trim(supplier_code)) = upper(normalized_supplier_code)
    and invoice_date <= p_period_to
    and closing_id is null;

  update public.accounts_payable_payments payment
  set closing_id = closing_row.id,
      updated_by = auth.uid()
  from public.accounts_payable payable
  where payment.payable_id = payable.id
    and upper(trim(payable.supplier_code)) = upper(normalized_supplier_code)
    and payment.payment_date <= p_period_to
    and payment.closing_id is null;

  return closing_row;
end;
$$;

create or replace function public.reopen_accounts_payable_period(
  p_closing_id uuid,
  p_reason text
)
returns public.accounts_payable_closings
language plpgsql
security invoker
set search_path = public
as $$
declare
  closing_row public.accounts_payable_closings;
begin
  if not public.is_master_admin() then
    raise exception '買掛締めを解除できるのは管理者のみです。';
  end if;
  if nullif(trim(p_reason),'') is null then
    raise exception '締め解除の理由を入力してください。';
  end if;

  update public.accounts_payable_closings
  set status = 'reopened',
      reopened_by = auth.uid(),
      reopened_at = now(),
      reopen_reason = trim(p_reason)
  where id = p_closing_id
    and status = 'closed'
  returning * into closing_row;

  if closing_row.id is null then
    raise exception '解除する買掛締めが見つかりません。';
  end if;

  update public.accounts_payable_payments
  set closing_id = null,
      updated_by = auth.uid()
  where closing_id = p_closing_id;

  update public.accounts_payable
  set closing_id = null,
      updated_by = auth.uid()
  where closing_id = p_closing_id;

  return closing_row;
end;
$$;

grant select, insert, update, delete
  on public.accounts_payable_closings to authenticated;
revoke all on function public.close_accounts_payable_period(
  text,date,date,date,numeric,numeric,numeric,numeric,jsonb
) from public, anon;
grant execute on function public.close_accounts_payable_period(
  text,date,date,date,numeric,numeric,numeric,numeric,jsonb
) to authenticated;
revoke all on function public.reopen_accounts_payable_period(uuid,text)
  from public, anon;
grant execute on function public.reopen_accounts_payable_period(uuid,text)
  to authenticated;

notify pgrst, 'reload schema';

commit;
