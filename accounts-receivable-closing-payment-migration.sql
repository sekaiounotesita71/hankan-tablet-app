-- Atomic export receipts, allocated across one billing closing (including carryover).
-- Existing invoices, closings, payments and balances are not rewritten.
begin;
alter table public.accounts_receivable_payments
  add column if not exists target_closing_id uuid references public.accounts_receivable_closings(id) on delete restrict,
  add column if not exists payment_group_id uuid;
create index if not exists idx_ar_payment_target_closing on public.accounts_receivable_payments(target_closing_id);
create index if not exists idx_ar_payment_group on public.accounts_receivable_payments(payment_group_id);
-- A fee can settle the last invoice after cash has been allocated to earlier invoices.
alter table public.accounts_receivable_payments drop constraint if exists accounts_receivable_payments_amount_jpy_check;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.accounts_receivable_payments'::regclass and conname='ar_payment_positive_settlement') then
    alter table public.accounts_receivable_payments add constraint ar_payment_positive_settlement
      check(amount_jpy>=0 and amount_jpy+bank_fee_jpy>0);
  end if;
end $$;

-- Older clients writing individual receipts must take the same invoice lock.
create or replace function public.lock_receivable_payment_parent() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and new.receivable_id is distinct from old.receivable_id then
    raise exception '入金先の売掛は変更できません。入金を取り消して登録し直してください。';
  end if;
  perform id from public.accounts_receivable where id=case when tg_op='DELETE' then old.receivable_id else new.receivable_id end for update;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists trg_ar_payment_parent_lock on public.accounts_receivable_payments;
create trigger trg_ar_payment_parent_lock before insert or update or delete on public.accounts_receivable_payments
for each row execute function public.lock_receivable_payment_parent();

create or replace function public.record_receivable_grouped_payment(
  p_request_id uuid,p_closing_id uuid,p_receivable_id uuid,p_payment_date date,
  p_amount_jpy numeric,p_bank_fee_jpy numeric default 0,p_reference_no text default null,
  p_memo text default null,p_expected_balance_jpy numeric default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  c public.accounts_receivable_closings%rowtype;
  r public.accounts_receivable%rowtype;
  item record;
  code text;
  ids uuid[];
  cash numeric:=round(coalesce(p_amount_jpy,0),2);
  fee numeric:=round(coalesce(p_bank_fee_jpy,0),2);
  available numeric;
  later numeric;
  remaining numeric;
  cash_left numeric;
  allocated numeric;
  allocated_cash numeric;
  n integer:=0;
begin
  if auth.uid() is null or not public.is_internal_user() then raise exception '社内権限でログインしてください。' using errcode='42501'; end if;
  if p_request_id is null or (p_closing_id is null)=(p_receivable_id is null) then raise exception '入金対象を1つ選択してください。'; end if;
  if p_payment_date is null or p_amount_jpy is null or cash::text in ('NaN','Infinity','-Infinity') or fee::text in ('NaN','Infinity','-Infinity')
    or cash<0 or fee<0 or cash+fee<=0 or cash<>p_amount_jpy or fee<>coalesce(p_bank_fee_jpy,0) then
    raise exception '入金日・入金額・手数料を確認してください。小数点以下は2桁までです。';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ar-payment:'||p_request_id::text,0));
  if exists(select 1 from public.accounts_receivable_payments where payment_group_id=p_request_id) then
    if exists(select 1 from public.accounts_receivable_payments where payment_group_id=p_request_id and (
      created_by is distinct from auth.uid() or target_closing_id is distinct from p_closing_id
      or (p_receivable_id is not null and receivable_id<>p_receivable_id) or payment_date<>p_payment_date
      or coalesce(reference_no,'')<>btrim(coalesce(p_reference_no,'')) or coalesce(memo,'')<>btrim(coalesce(p_memo,''))))
      or (select sum(amount_jpy) from public.accounts_receivable_payments where payment_group_id=p_request_id)<>cash
      or (select sum(bank_fee_jpy) from public.accounts_receivable_payments where payment_group_id=p_request_id)<>fee then
      raise exception '同じ受付番号で異なる入金は登録できません。入金履歴を再読込してください。';
    end if;
    return jsonb_build_object('payment_group_id',p_request_id,'already_recorded',true);
  end if;
  if p_closing_id is not null then
    select * into c from public.accounts_receivable_closings where id=p_closing_id for update;
    if not found or c.status<>'closed' then raise exception '入金対象の請求締めが見つかりません。'; end if;
    code:=public.canonical_importer_code(c.importer_code);
  else
    select * into r from public.accounts_receivable where id=p_receivable_id;
    if not found then raise exception '売掛データが見つかりません。'; end if;
    code:=public.canonical_importer_code(r.importer_code);
  end if;
  perform id from public.accounts_receivable where public.canonical_importer_code(importer_code)=code order by invoice_date,created_at,id for update;
  if exists(select 1 from public.accounts_receivable_closings where public.canonical_importer_code(importer_code)=code and status='closed' and period_to>=p_payment_date) then
    raise exception '入金日が請求締め済み期間に含まれます。該当する締めを確認・解除してから登録してください。';
  end if;
  if p_closing_id is not null then
    select coalesce(array_agg(a.id),'{}'::uuid[]) into ids from public.accounts_receivable a
    where public.canonical_importer_code(a.importer_code)=code and a.invoice_date<=c.period_to
      and (a.source_type='opening' or a.invoice_date>=coalesce((select operation_start_date from public.accounts_receivable_settings where singleton),date '2026-08-01'))
      and (a.created_at<=c.closed_at or a.closing_id=c.id or exists(select 1 from jsonb_array_elements(coalesce(c.snapshot->'charges','[]'::jsonb)) x where x->>'id'=a.id::text));
  else
    ids:=array[p_receivable_id];
  end if;
  select coalesce(sum(a.amount_jpy-coalesce(p.settled,0)),0) into available
    from public.accounts_receivable a left join lateral (
      select sum(amount_jpy+bank_fee_jpy) settled from public.accounts_receivable_payments where receivable_id=a.id
    ) p on true where a.id=any(ids);
  if p_closing_id is not null then
    select coalesce(sum(amount_jpy+bank_fee_jpy),0) into later from public.accounts_receivable_payments where receivable_id=any(ids) and payment_date>c.period_to;
    available:=greatest(least(available,c.closing_balance_jpy-later),0);
  end if;
  available:=round(available,2);
  if p_expected_balance_jpy is null or p_expected_balance_jpy::text in ('NaN','Infinity','-Infinity') or available<>p_expected_balance_jpy then
    raise exception '他の入金等により残額が変わっています。再読込して確認してください。';
  end if;
  if cash+fee>available then raise exception '入金額と手数料の合計が未回収額（%円）を超えています。',available; end if;
  perform set_config('app.audit_source','receivable-grouped-payment',true);
  remaining:=cash+fee; cash_left:=cash;
  for item in select a.id,a.amount_jpy-coalesce(p.settled,0) balance
    from public.accounts_receivable a left join lateral (
      select sum(amount_jpy+bank_fee_jpy) settled from public.accounts_receivable_payments where receivable_id=a.id
    ) p on true where a.id=any(ids) and a.amount_jpy-coalesce(p.settled,0)>0 order by a.invoice_date,a.created_at,a.id loop
    exit when remaining<=0;
    allocated:=least(remaining,item.balance); allocated_cash:=least(cash_left,allocated);
    insert into public.accounts_receivable_payments(receivable_id,payment_date,amount_jpy,bank_fee_jpy,reference_no,memo,target_closing_id,payment_group_id,created_by,updated_by)
      values(item.id,p_payment_date,allocated_cash,allocated-allocated_cash,nullif(btrim(coalesce(p_reference_no,'')),''),nullif(btrim(coalesce(p_memo,'')),''),p_closing_id,p_request_id,auth.uid(),auth.uid());
    remaining:=remaining-allocated; cash_left:=cash_left-allocated_cash; n:=n+1;
  end loop;
  if remaining<>0 or n=0 then raise exception '入金を全件に配分できませんでした。変更は保存されていません。'; end if;
  return jsonb_build_object('payment_group_id',p_request_id,'payment_count',n,'allocated_amount_jpy',cash+fee,'already_recorded',false);
end $$;

create or replace function public.delete_receivable_payment_group(p_group_id uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null or not public.is_internal_user() or not public.is_master_admin() then raise exception '入金を取り消せるのは管理者のみです。' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ar-payment:'||p_group_id::text,0));
  perform r.id from public.accounts_receivable r where exists(select 1 from public.accounts_receivable_payments p where p.payment_group_id=p_group_id and p.receivable_id=r.id) order by r.invoice_date,r.created_at,r.id for update;
  if not exists(select 1 from public.accounts_receivable_payments where payment_group_id=p_group_id) then raise exception '対象の入金が見つかりません。'; end if;
  -- Existing closed-payment triggers protect every allocation; failure rolls back the group.
  delete from public.accounts_receivable_payments where payment_group_id=p_group_id;
end $$;
revoke all on function public.lock_receivable_payment_parent() from public,anon;
revoke all on function public.record_receivable_grouped_payment(uuid,uuid,uuid,date,numeric,numeric,text,text,numeric) from public,anon;
revoke all on function public.delete_receivable_payment_group(uuid) from public,anon;
grant execute on function public.record_receivable_grouped_payment(uuid,uuid,uuid,date,numeric,numeric,text,text,numeric) to authenticated;
grant execute on function public.delete_receivable_payment_group(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
