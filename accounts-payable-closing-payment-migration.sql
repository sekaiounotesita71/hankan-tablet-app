-- Register one payment against one accounts-payable closing and allocate it to open payables.
-- Run after accounts-payable-closing-migration.sql.

begin;

alter table public.accounts_payable_payments
  add column if not exists target_closing_id uuid
    references public.accounts_payable_closings(id) on delete restrict;

alter table public.accounts_payable_payments
  add column if not exists payment_group_id uuid;

create index if not exists idx_accounts_payable_payments_target_closing
  on public.accounts_payable_payments(target_closing_id, payment_date desc);

create index if not exists idx_accounts_payable_payments_group
  on public.accounts_payable_payments(payment_group_id);

create or replace function public.register_accounts_payable_closing_payment(
  p_closing_id uuid,
  p_payment_date date,
  p_amount_jpy numeric,
  p_bank_fee_jpy numeric default 0,
  p_reference_no text default null,
  p_memo text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  closing_row public.accounts_payable_closings;
  payable_row record;
  group_id uuid := gen_random_uuid();
  requested_amount numeric(18,2) := round(coalesce(p_amount_jpy,0),2);
  remaining_amount numeric(18,2);
  available_amount numeric(18,2);
  allocation_amount numeric(18,2);
  allocated_amount numeric(18,2) := 0;
  fee_amount numeric(18,2) := round(coalesce(p_bank_fee_jpy,0),2);
  fee_pending numeric(18,2);
  inserted_count integer := 0;
begin
  if auth.uid() is null or not public.is_internal_user() then
    raise exception 'ログインしてください。';
  end if;

  select * into closing_row
  from public.accounts_payable_closings
  where id = p_closing_id
  for update;

  if closing_row.id is null or closing_row.status <> 'closed' then
    raise exception '支払対象の買掛締めが見つかりません。';
  end if;
  if p_payment_date is null then
    raise exception '支払日を入力してください。';
  end if;
  if requested_amount <= 0 then
    raise exception '支払額は0円より大きい金額を入力してください。';
  end if;
  if fee_amount < 0 then
    raise exception '振込手数料は0円以上で入力してください。';
  end if;
  if p_payment_date <= closing_row.period_to then
    raise exception '締め済み期間には支払を追加できません。支払日は締め日の翌日以降を指定してください。';
  end if;

  perform payable.id
  from public.accounts_payable payable
  where upper(trim(payable.supplier_code)) = upper(trim(closing_row.supplier_code))
    and payable.invoice_date <= closing_row.period_to
  order by payable.invoice_date, payable.created_at, payable.id
  for update;

  select coalesce(sum(greatest(payable.amount_jpy - coalesce(payment.paid_amount,0),0)),0)
    into available_amount
  from public.accounts_payable payable
  left join lateral (
    select sum(existing.amount_jpy) as paid_amount
    from public.accounts_payable_payments existing
    where existing.payable_id = payable.id
  ) payment on true
  where upper(trim(payable.supplier_code)) = upper(trim(closing_row.supplier_code))
    and payable.invoice_date <= closing_row.period_to;

  available_amount := round(coalesce(available_amount,0),2);
  if requested_amount > available_amount then
    raise exception '支払額が買掛締めの支払残を超えています。支払残: %円', available_amount;
  end if;

  remaining_amount := requested_amount;
  fee_pending := fee_amount;

  for payable_row in
    select
      payable.id,
      round(greatest(payable.amount_jpy - coalesce(sum(existing.amount_jpy),0),0),2) as balance
    from public.accounts_payable payable
    left join public.accounts_payable_payments existing
      on existing.payable_id = payable.id
    where upper(trim(payable.supplier_code)) = upper(trim(closing_row.supplier_code))
      and payable.invoice_date <= closing_row.period_to
    group by payable.id, payable.invoice_date, payable.created_at, payable.amount_jpy
    having round(greatest(payable.amount_jpy - coalesce(sum(existing.amount_jpy),0),0),2) > 0
    order by payable.invoice_date, payable.created_at, payable.id
  loop
    exit when remaining_amount <= 0;
    allocation_amount := least(remaining_amount, payable_row.balance);

    insert into public.accounts_payable_payments (
      payable_id, payment_date, amount_jpy, bank_fee_jpy,
      reference_no, memo, target_closing_id, payment_group_id,
      created_by, updated_by
    ) values (
      payable_row.id, p_payment_date, allocation_amount, fee_pending,
      nullif(trim(p_reference_no),''), nullif(trim(p_memo),''),
      closing_row.id, group_id, auth.uid(), auth.uid()
    );

    remaining_amount := round(remaining_amount - allocation_amount,2);
    allocated_amount := round(allocated_amount + allocation_amount,2);
    fee_pending := 0;
    inserted_count := inserted_count + 1;
  end loop;

  if remaining_amount <> 0 or inserted_count = 0 then
    raise exception '支払額を買掛明細へ配賦できませんでした。買掛データを再読み込みしてください。';
  end if;

  return jsonb_build_object(
    'payment_group_id', group_id,
    'payment_count', inserted_count,
    'allocated_amount_jpy', allocated_amount
  );
end;
$$;

revoke all on function public.register_accounts_payable_closing_payment(
  uuid,date,numeric,numeric,text,text
) from public, anon;

grant execute on function public.register_accounts_payable_closing_payment(
  uuid,date,numeric,numeric,text,text
) to authenticated;

notify pgrst, 'reload schema';

commit;
