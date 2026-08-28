-- Domestic billing closing, recurring 10/15-day terms, and invoice snapshots.
-- Run after domestic-sales-migration.sql.

begin;

create sequence if not exists public.domestic_billing_invoice_no_seq start with 1;

create table if not exists public.domestic_billing_closings (
  id uuid primary key default gen_random_uuid(),
  invoice_no text not null unique,
  customer_code text not null
    references public.domestic_customer_master(customer_code) on delete restrict,
  customer_name_snapshot text not null,
  period_from date not null,
  period_to date not null,
  due_date date not null,
  carryover_amount_jpy numeric(18,2) not null default 0,
  sales_amount_jpy numeric(18,2) not null default 0,
  payment_amount_jpy numeric(18,2) not null default 0,
  billing_amount_jpy numeric(18,2) not null default 0,
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
  unique(customer_code,period_from,period_to),
  check (period_from <= period_to)
);

create index if not exists idx_domestic_billing_closings_customer
  on public.domestic_billing_closings(customer_code,period_to desc);

drop trigger if exists trg_domestic_billing_closings_touch
  on public.domestic_billing_closings;
create trigger trg_domestic_billing_closings_touch
before update on public.domestic_billing_closings
for each row execute function public.touch_domestic_record();

do $$
begin
  if to_regprocedure('public.log_business_audit_event()') is not null then
    drop trigger if exists trg_business_audit on public.domestic_billing_closings;
    create trigger trg_business_audit
    after insert or update or delete on public.domestic_billing_closings
    for each row execute function public.log_business_audit_event();
  end if;
end $$;

alter table public.domestic_billing_closings enable row level security;

drop policy if exists "internal read domestic billing closings"
  on public.domestic_billing_closings;
create policy "internal read domestic billing closings"
on public.domestic_billing_closings for select to authenticated
using (public.is_internal_user());

drop policy if exists "internal insert domestic billing closings"
  on public.domestic_billing_closings;
create policy "internal insert domestic billing closings"
on public.domestic_billing_closings for insert to authenticated
with check (public.is_internal_user() and closed_by = auth.uid());

drop policy if exists "internal reclose domestic billing closings"
  on public.domestic_billing_closings;
create policy "internal reclose domestic billing closings"
on public.domestic_billing_closings for update to authenticated
using (public.is_internal_user() and status = 'reopened')
with check (public.is_internal_user() and status = 'closed' and closed_by = auth.uid());

drop policy if exists "admins update domestic billing closings"
  on public.domestic_billing_closings;
create policy "admins update domestic billing closings"
on public.domestic_billing_closings for update to authenticated
using (public.is_master_admin())
with check (public.is_master_admin());

drop policy if exists "admins delete domestic billing closings"
  on public.domestic_billing_closings;
create policy "admins delete domestic billing closings"
on public.domestic_billing_closings for delete to authenticated
using (public.is_master_admin());

create or replace function public.domestic_receivable_due_date(
  p_sale_date date,
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
  sale_month date;
  sale_month_last_day date;
  effective_closing_date date;
  closing_month date;
  payment_month date;
  payment_month_end date;
  target_day integer;
begin
  if p_sale_date is null then return null; end if;

  sale_month := date_trunc('month',p_sale_date)::date;
  sale_month_last_day := (sale_month + interval '1 month - 1 day')::date;

  -- A 10-day customer is billed three times per month: 10th, 20th, and month-end.
  if least(greatest(coalesce(p_closing_day,31),1),31) = 10 then
    if extract(day from p_sale_date)::integer <= 10 then return sale_month + 19; end if;
    if extract(day from p_sale_date)::integer <= 20 then return sale_month_last_day; end if;
    return (sale_month + interval '1 month')::date + 9;
  end if;

  -- A 15-day customer is billed twice per month: 15th and month-end.
  if least(greatest(coalesce(p_closing_day,31),1),31) = 15 then
    if extract(day from p_sale_date)::integer <= 15 then return sale_month_last_day; end if;
    return (sale_month + interval '1 month')::date + 14;
  end if;

  effective_closing_date := sale_month + (
    least(
      greatest(coalesce(p_closing_day,31),1),
      extract(day from sale_month_last_day)::integer
    ) - 1
  );
  closing_month := case
    when p_sale_date <= effective_closing_date then sale_month
    else (sale_month + interval '1 month')::date
  end;
  payment_month := (
    closing_month
    + make_interval(months => greatest(coalesce(p_payment_month_offset,1),0)::integer)
  )::date;
  payment_month_end := (payment_month + interval '1 month - 1 day')::date;
  target_day := least(
    greatest(coalesce(p_payment_day,31),1),
    extract(day from payment_month_end)::integer
  );
  return payment_month + (target_day - 1);
end;
$$;

update public.domestic_receivables receivable
set due_date = public.domestic_receivable_due_date(
      receivable.invoice_date,
      customer.closing_day,
      customer.payment_month_offset,
      customer.payment_day
    ),
    updated_by = coalesce(auth.uid(),receivable.updated_by)
from public.domestic_customer_master customer
where customer.customer_code = receivable.customer_code
  and receivable.status <> 'cancelled';

create or replace function public.close_domestic_billing_period(
  p_customer_code text,
  p_period_from date,
  p_period_to date,
  p_due_date date,
  p_carryover_amount_jpy numeric,
  p_sales_amount_jpy numeric,
  p_payment_amount_jpy numeric,
  p_billing_amount_jpy numeric,
  p_snapshot jsonb
)
returns public.domestic_billing_closings
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  customer_row public.domestic_customer_master%rowtype;
  closing_row public.domestic_billing_closings;
  generated_invoice_no text;
begin
  if auth.uid() is null or not public.is_internal_user() then
    raise exception 'ログインしてください。';
  end if;
  if nullif(btrim(coalesce(p_customer_code,'')),'') is null then
    raise exception '得意先を指定してください。';
  end if;
  if p_period_from is null or p_period_to is null or p_period_from > p_period_to then
    raise exception '請求締め期間が正しくありません。';
  end if;
  if p_due_date is null then
    raise exception '支払期限を指定してください。';
  end if;

  select * into customer_row
  from public.domestic_customer_master
  where customer_code = btrim(p_customer_code)
    and active;
  if not found then raise exception '有効な国内得意先が見つかりません。'; end if;

  if exists (
    select 1 from public.domestic_billing_closings closing
    where closing.customer_code = customer_row.customer_code
      and closing.status = 'closed'
      and daterange(closing.period_from,closing.period_to,'[]')
        && daterange(p_period_from,p_period_to,'[]')
  ) then
    raise exception '指定期間はすでに請求締め済みです。';
  end if;

  generated_invoice_no := 'D-' || to_char(p_period_to,'YYYYMMDD') || '-'
    || lpad(nextval('public.domestic_billing_invoice_no_seq')::text,6,'0');

  insert into public.domestic_billing_closings (
    invoice_no,customer_code,customer_name_snapshot,period_from,period_to,due_date,
    carryover_amount_jpy,sales_amount_jpy,payment_amount_jpy,billing_amount_jpy,
    status,snapshot,closed_by,closed_at,reopened_by,reopened_at,reopen_reason
  ) values (
    generated_invoice_no,customer_row.customer_code,customer_row.customer_name,
    p_period_from,p_period_to,p_due_date,
    round(coalesce(p_carryover_amount_jpy,0),2),round(coalesce(p_sales_amount_jpy,0),2),
    round(coalesce(p_payment_amount_jpy,0),2),round(coalesce(p_billing_amount_jpy,0),2),
    'closed',coalesce(p_snapshot,'{}'::jsonb),auth.uid(),now(),null,null,null
  )
  on conflict (customer_code,period_from,period_to)
  do update set
    customer_name_snapshot = excluded.customer_name_snapshot,
    due_date = excluded.due_date,
    carryover_amount_jpy = excluded.carryover_amount_jpy,
    sales_amount_jpy = excluded.sales_amount_jpy,
    payment_amount_jpy = excluded.payment_amount_jpy,
    billing_amount_jpy = excluded.billing_amount_jpy,
    status = 'closed',snapshot = excluded.snapshot,
    closed_by = auth.uid(),closed_at = now(),
    reopened_by = null,reopened_at = null,reopen_reason = null
  returning * into closing_row;

  return closing_row;
end;
$$;

create or replace function public.reopen_domestic_billing_period(
  p_closing_id uuid,
  p_reason text
)
returns public.domestic_billing_closings
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  closing_row public.domestic_billing_closings;
begin
  if not public.is_master_admin() then
    raise exception '請求締めを解除できるのは管理者のみです。';
  end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception '締め解除の理由を入力してください。';
  end if;

  update public.domestic_billing_closings
  set status = 'reopened',reopened_by = auth.uid(),reopened_at = now(),reopen_reason = btrim(p_reason)
  where id = p_closing_id and status = 'closed'
  returning * into closing_row;
  if closing_row.id is null then raise exception '解除する請求締めが見つかりません。'; end if;
  return closing_row;
end;
$$;

grant select,insert,update,delete on public.domestic_billing_closings to authenticated;
grant usage,select on sequence public.domestic_billing_invoice_no_seq to authenticated;
revoke all on function public.close_domestic_billing_period(text,date,date,date,numeric,numeric,numeric,numeric,jsonb)
  from public,anon;
grant execute on function public.close_domestic_billing_period(text,date,date,date,numeric,numeric,numeric,numeric,jsonb)
  to authenticated;
revoke all on function public.reopen_domestic_billing_period(uuid,text)
  from public,anon;
grant execute on function public.reopen_domestic_billing_period(uuid,text)
  to authenticated;

do $$
begin
  if public.domestic_receivable_due_date(date '2026-08-15',15::smallint,1::smallint,15::smallint) <> date '2026-08-31' then
    raise exception 'Domestic 15-day first-cycle due date check failed.';
  end if;
  if public.domestic_receivable_due_date(date '2026-08-16',15::smallint,1::smallint,15::smallint) <> date '2026-09-15' then
    raise exception 'Domestic 15-day second-cycle due date check failed.';
  end if;
  if public.domestic_receivable_due_date(date '2026-08-10',10::smallint,1::smallint,10::smallint) <> date '2026-08-20' then
    raise exception 'Domestic 10-day first-cycle due date check failed.';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
