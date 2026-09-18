-- Atomic domestic receipt allocation. Existing payments and balances are unchanged.
-- Requires domestic-sales-migration.sql and domestic-billing-closing-migration.sql.
begin;

alter table public.domestic_receivable_payments
  add column if not exists target_closing_id uuid references public.domestic_billing_closings(id) on delete restrict,
  add column if not exists payment_group_id uuid,
  add column if not exists cash_amount_jpy numeric(18,2);

-- For new grouped payments amount_jpy is the settlement (cash + fee).
-- NULL cash_amount_jpy preserves the historical, cash-only settlement semantics.
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.domestic_receivable_payments'::regclass and conname='domestic_payment_cash_settlement_check') then
    alter table public.domestic_receivable_payments add constraint domestic_payment_cash_settlement_check
      check(cash_amount_jpy is null or (cash_amount_jpy >= 0 and cash_amount_jpy + bank_fee_jpy = amount_jpy));
  end if;
end $$;
create index if not exists idx_domestic_payment_target_closing on public.domestic_receivable_payments(target_closing_id);
create index if not exists idx_domestic_payment_group on public.domestic_receivable_payments(payment_group_id);

create or replace function public.record_domestic_grouped_payment(
  p_request_id uuid,
  p_closing_id uuid,
  p_receivable_id uuid,
  p_payment_date date,
  p_amount_jpy numeric,
  p_bank_fee_jpy numeric default 0,
  p_reference_no text default null,
  p_memo text default null,
  p_expected_balance_jpy numeric default null
)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  closing_row public.domestic_billing_closings%rowtype;
  target_row public.domestic_receivables%rowtype;
  item record;
  target_ids uuid[];
  customer text;
  cash numeric := round(coalesce(p_amount_jpy,0),2);
  fee numeric := round(coalesce(p_bank_fee_jpy,0),2);
  requested numeric;
  available numeric;
  later_settled numeric;
  remaining numeric;
  cash_left numeric;
  allocated numeric;
  allocated_cash numeric;
  inserted_count integer := 0;
begin
  if auth.uid() is null or not public.is_internal_user() then raise exception '社内権限でログインしてください。' using errcode='42501'; end if;
  if p_request_id is null or (p_closing_id is null) = (p_receivable_id is null) then raise exception '入金対象を1つ選択してください。'; end if;
  if p_payment_date is null or cash::text in ('NaN','Infinity','-Infinity') or fee::text in ('NaN','Infinity','-Infinity')
     or cash < 0 or fee < 0 or cash + fee <= 0 or cash <> p_amount_jpy or fee <> coalesce(p_bank_fee_jpy,0) then
    raise exception '入金日・入金額・手数料を確認してください。小数点以下は2桁までです。';
  end if;
  requested := cash + fee;
  perform pg_advisory_xact_lock(hashtextextended('domestic-payment:'||p_request_id::text,0));
  if exists(select 1 from public.domestic_receivable_payments where payment_group_id=p_request_id) then
    if exists(select 1 from public.domestic_receivable_payments where payment_group_id=p_request_id and (
        created_by is distinct from auth.uid() or target_closing_id is distinct from p_closing_id
        or (p_receivable_id is not null and receivable_id<>p_receivable_id)
        or payment_date<>p_payment_date or coalesce(reference_no,'')<>btrim(coalesce(p_reference_no,''))
        or coalesce(memo,'')<>btrim(coalesce(p_memo,''))))
      or (select sum(cash_amount_jpy) from public.domestic_receivable_payments where payment_group_id=p_request_id) <> cash
      or (select sum(bank_fee_jpy) from public.domestic_receivable_payments where payment_group_id=p_request_id) <> fee then
      raise exception '同じ受付番号で異なる入金は登録できません。入金履歴を再読込してください。';
    end if;
    return jsonb_build_object('payment_group_id',p_request_id,'already_recorded',true,'allocated_amount_jpy',requested);
  end if;

  if p_closing_id is not null then
    select * into closing_row from public.domestic_billing_closings where id=p_closing_id for update;
    if not found or closing_row.status<>'closed' then raise exception '入金対象の請求締めが見つかりません。'; end if;
    customer := closing_row.customer_code;
  else
    select * into target_row from public.domestic_receivables where id=p_receivable_id;
    if not found then raise exception '売掛データが見つかりません。'; end if;
    customer := target_row.customer_code;
  end if;

  -- Lock the customer before deciding targets. Competing payments use row locks too.
  perform id from public.domestic_receivables where customer_code=customer order by invoice_date,created_at,id for update;
  if exists(select 1 from public.domestic_billing_closings where customer_code=customer and status='closed' and period_to>=p_payment_date) then
    raise exception '入金日が請求締め済み期間に含まれます。該当する締めを確認・解除してから登録してください。';
  end if;
  if p_closing_id is not null then
    select coalesce(array_agg(r.id),'{}'::uuid[]) into target_ids
    from public.domestic_receivables r
    where r.customer_code=customer and r.status<>'cancelled' and r.invoice_date<=closing_row.period_to
      and (r.created_at<=closing_row.closed_at or exists(
        select 1 from jsonb_array_elements(coalesce(closing_row.snapshot->'charges','[]'::jsonb)) charge where charge->>'id'=r.id::text));
  else
    target_ids := array[p_receivable_id];
  end if;
  select coalesce(sum(balance_jpy),0) into available from public.domestic_receivables where id=any(target_ids) and status<>'cancelled';
  if p_closing_id is not null then
    select coalesce(sum(amount_jpy),0) into later_settled from public.domestic_receivable_payments
      where receivable_id=any(target_ids) and payment_date>closing_row.period_to;
    available := greatest(least(available,closing_row.billing_amount_jpy-later_settled),0);
  end if;
  available := round(available,2);
  if p_expected_balance_jpy is null or p_expected_balance_jpy::text in ('NaN','Infinity','-Infinity') or available<>p_expected_balance_jpy then
    raise exception '他の入金等により残額が変わっています。再読込して確認してください。';
  end if;
  if requested>available then raise exception '入金額と手数料の合計が未回収額（%円）を超えています。',available; end if;

  perform set_config('app.audit_source','domestic-grouped-payment',true);
  remaining := requested;
  cash_left := cash;
  for item in select * from public.domestic_receivables where id=any(target_ids) and status<>'cancelled' and balance_jpy>0 order by invoice_date,created_at,id loop
    exit when remaining<=0;
    allocated := least(remaining,item.balance_jpy);
    allocated_cash := least(cash_left,allocated);
    insert into public.domestic_receivable_payments(receivable_id,payment_date,amount_jpy,bank_fee_jpy,cash_amount_jpy,reference_no,memo,target_closing_id,payment_group_id,created_by)
      values(item.id,p_payment_date,allocated,allocated-allocated_cash,allocated_cash,nullif(btrim(coalesce(p_reference_no,'')),''),nullif(btrim(coalesce(p_memo,'')),''),p_closing_id,p_request_id,auth.uid());
    update public.domestic_receivables set paid_amount_jpy=paid_amount_jpy+allocated,balance_jpy=balance_jpy-allocated,
      status=case when balance_jpy-allocated=0 then 'paid' else 'partial' end,updated_by=auth.uid() where id=item.id;
    remaining := remaining-allocated;
    cash_left := cash_left-allocated_cash;
    inserted_count := inserted_count+1;
  end loop;
  if remaining<>0 or inserted_count=0 then raise exception '入金を全件に配分できませんでした。変更は保存されていません。'; end if;
  return jsonb_build_object('payment_group_id',p_request_id,'payment_count',inserted_count,'allocated_amount_jpy',requested,'already_recorded',false);
end;
$$;
revoke all on function public.record_domestic_grouped_payment(uuid,uuid,uuid,date,numeric,numeric,text,text,numeric) from public,anon;
grant execute on function public.record_domestic_grouped_payment(uuid,uuid,uuid,date,numeric,numeric,text,text,numeric) to authenticated;
notify pgrst,'reload schema';
commit;
