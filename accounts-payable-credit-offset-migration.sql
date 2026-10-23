-- Cash and credit offsets are separate. Existing invoices/payments are unchanged.
-- Run after accounts-payable-closing-payment-migration.sql.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.accounts_payable_settlements (
  id uuid primary key,
  target_closing_id uuid not null references public.accounts_payable_closings(id) on delete restrict,
  request jsonb not null,
  result jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz
);
alter table public.accounts_payable_settlements enable row level security;
drop policy if exists "internal read payable settlements" on public.accounts_payable_settlements;
create policy "internal read payable settlements" on public.accounts_payable_settlements
  for select to authenticated using (public.is_internal_user());
revoke all on public.accounts_payable_settlements from public, anon, authenticated;
grant select on public.accounts_payable_settlements to authenticated;

alter table public.accounts_payable_payments
  add column if not exists credit_offset_jpy numeric(18,2) not null default 0;
alter table public.accounts_payable_payments drop constraint if exists accounts_payable_payments_amount_jpy_check;
alter table public.accounts_payable_payments drop constraint if exists accounts_payable_payment_cash_or_offset;
alter table public.accounts_payable_payments add constraint accounts_payable_payment_cash_or_offset check (
  (amount_jpy > 0 and credit_offset_jpy = 0)
  or (amount_jpy = 0 and credit_offset_jpy <> 0 and bank_fee_jpy = 0
      and payment_group_id is not null and target_closing_id is not null)
);

-- Serialize every payment path on its invoice. Managed groups cannot be partly
-- edited through the table API; closing/reopening may only change closing metadata.
create or replace function public.protect_payable_settlement_payment()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  managed boolean;
begin
  if tg_op <> 'INSERT' then
    perform id from public.accounts_payable where id = old.payable_id for update;
  end if;
  if tg_op <> 'DELETE' then
    perform id from public.accounts_payable where id = new.payable_id for update;
  end if;
  if current_user in ('authenticated','anon') then
    managed := (tg_op <> 'INSERT' and exists (
      select 1 from public.accounts_payable_settlements where id = old.payment_group_id
    ));
    if tg_op = 'DELETE' and managed then
      raise exception '相殺を含む支払は締め単位で取り消してください。';
    end if;
    if tg_op <> 'DELETE' then
      if tg_op = 'UPDATE' and managed
         and (to_jsonb(new) - array['closing_id','updated_by','updated_at'])
           = (to_jsonb(old) - array['closing_id','updated_by','updated_at']) then
        return new;
      end if;
      if managed or new.credit_offset_jpy <> 0 or exists (
        select 1 from public.accounts_payable_settlements where id = new.payment_group_id
      ) then
        raise exception '相殺を含む支払は専用の支払処理を使用してください。';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists trg_protect_payable_settlement_payment on public.accounts_payable_payments;
create trigger trg_protect_payable_settlement_payment before insert or update or delete
  on public.accounts_payable_payments for each row execute function public.protect_payable_settlement_payment();

create or replace function public.protect_offset_payable()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.accounts_payable_payments p
             where p.payable_id = old.id and p.credit_offset_jpy <> 0)
     and (tg_op = 'DELETE' or
          (new.supplier_code,new.invoice_date,new.amount_jpy) is distinct from
          (old.supplier_code,old.invoice_date,old.amount_jpy)) then
    raise exception '相殺済みの買掛は変更できません。先に対象の支払・相殺を取り消してください。';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists trg_protect_offset_payable on public.accounts_payable;
create trigger trg_protect_offset_payable before update or delete on public.accounts_payable
  for each row execute function public.protect_offset_payable();

create or replace function public.register_accounts_payable_net_payment(
  p_closing_id uuid, p_payment_date date, p_amount_jpy numeric,
  p_bank_fee_jpy numeric default 0, p_reference_no text default null,
  p_memo text default null, p_request_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.accounts_payable_closings;
  previous public.accounts_payable_settlements;
  r record;
  group_id uuid := coalesce(p_request_id, gen_random_uuid());
  request_data jsonb;
  cash numeric(18,2) := round(coalesce(p_amount_jpy,0),2);
  fee numeric(18,2) := round(coalesce(p_bank_fee_jpy,0),2);
  debit numeric(18,2);
  credit numeric(18,2);
  offset_total numeric(18,2);
  left_offset numeric(18,2);
  left_cash numeric(18,2);
  part numeric(18,2);
  result_data jsonb;
begin
  if auth.uid() is null or not public.is_internal_user() then raise exception 'ログインしてください。'; end if;
  if p_payment_date is null or p_amount_jpy is null or cash < 0 or fee < 0
     or p_amount_jpy::text in ('NaN','Infinity','-Infinity')
     or coalesce(p_bank_fee_jpy,0)::text in ('NaN','Infinity','-Infinity') then
    raise exception '支払日・支払額・手数料を確認してください。';
  end if;
  request_data := jsonb_build_object('closing_id',p_closing_id,'date',p_payment_date,
    'cash',cash,'fee',fee,'reference',nullif(trim(p_reference_no),''),'memo',nullif(trim(p_memo),''));
  perform pg_advisory_xact_lock(hashtextextended('ap-request:' || group_id::text,0));
  select * into previous from public.accounts_payable_settlements where id = group_id;
  if found then
    if previous.created_by is distinct from auth.uid() or previous.request <> request_data then
      raise exception '同じ受付番号で異なる支払を登録できません。';
    end if;
    if previous.cancelled_at is not null then raise exception 'この受付番号の支払は取消済みです。'; end if;
    return previous.result;
  end if;
  if exists (select 1 from public.accounts_payable_payments where payment_group_id=group_id) then
    raise exception 'この受付番号はすでに使用されています。';
  end if;
  select * into c from public.accounts_payable_closings where id = p_closing_id for update;
  if c.id is null or c.status <> 'closed' then raise exception '支払対象の買掛締めが見つかりません。'; end if;
  if p_payment_date <= c.period_to then raise exception '支払日は締め日の翌日以降を指定してください。'; end if;
  if exists (select 1 from public.accounts_payable_closings x
    where upper(trim(x.supplier_code)) = upper(trim(c.supplier_code)) and x.status = 'closed'
      and p_payment_date between x.period_from and x.period_to) then
    raise exception '指定日の支払は締め済みです。先に締め解除してください。';
  end if;

  perform p.id from public.accounts_payable p
  where upper(trim(p.supplier_code)) = upper(trim(c.supplier_code)) and p.invoice_date <= c.period_to
  order by p.invoice_date,p.created_at,p.id for update;
  select coalesce(sum(greatest(b.balance,0)),0),coalesce(sum(greatest(-b.balance,0)),0)
  into debit,credit from (
    select p.id,round(p.amount_jpy-coalesce(sum(m.amount_jpy+m.credit_offset_jpy),0),2) balance
    from public.accounts_payable p left join public.accounts_payable_payments m on m.payable_id=p.id
    where upper(trim(p.supplier_code))=upper(trim(c.supplier_code)) and p.invoice_date<=c.period_to
    group by p.id
  ) b;
  if cash > greatest(debit-credit,0) then
    raise exception '支払額が赤伝相殺後の支払残を超えています。支払残: %円',greatest(debit-credit,0);
  end if;
  offset_total := least(debit,credit);
  if cash = 0 and offset_total = 0 then raise exception '支払・相殺対象の残高がありません。'; end if;
  if cash = 0 and fee <> 0 then raise exception '相殺のみの場合、振込手数料は0円にしてください。'; end if;
  -- Backdating across existing settlements would invalidate historical balances.
  if exists (select 1 from public.accounts_payable_payments m join public.accounts_payable p on p.id=m.payable_id
    where upper(trim(p.supplier_code))=upper(trim(c.supplier_code)) and p.invoice_date<=c.period_to
      and m.payment_date>p_payment_date) then
    raise exception '後日の支払が登録済みです。既存の支払日以降の日付で登録してください。';
  end if;
  insert into public.accounts_payable_settlements(id,target_closing_id,request,created_by)
  values(group_id,c.id,request_data,auth.uid());
  left_offset := offset_total;
  for r in
    select p.id,round(p.amount_jpy-coalesce(sum(m.amount_jpy+m.credit_offset_jpy),0),2) balance
    from public.accounts_payable p left join public.accounts_payable_payments m on m.payable_id=p.id
    where upper(trim(p.supplier_code))=upper(trim(c.supplier_code)) and p.invoice_date<=c.period_to
    group by p.id having round(p.amount_jpy-coalesce(sum(m.amount_jpy+m.credit_offset_jpy),0),2)<0
    order by p.invoice_date,p.created_at,p.id
  loop
    exit when left_offset<=0;
    part := least(left_offset,-r.balance);
    insert into public.accounts_payable_payments(payable_id,payment_date,amount_jpy,credit_offset_jpy,
      target_closing_id,payment_group_id,memo,created_by,updated_by)
    values(r.id,p_payment_date,0,-part,c.id,group_id,'赤伝・過払の相殺',auth.uid(),auth.uid());
    left_offset := left_offset-part;
  end loop;
  if left_offset<>0 then raise exception '相殺元を配賦できませんでした。'; end if;
  left_offset := offset_total;
  left_cash := cash;
  for r in
    select p.id,round(p.amount_jpy-coalesce(sum(m.amount_jpy+m.credit_offset_jpy),0),2) balance
    from public.accounts_payable p left join public.accounts_payable_payments m on m.payable_id=p.id
    where upper(trim(p.supplier_code))=upper(trim(c.supplier_code)) and p.invoice_date<=c.period_to
    group by p.id having round(p.amount_jpy-coalesce(sum(m.amount_jpy+m.credit_offset_jpy),0),2)>0
    order by p.invoice_date,p.created_at,p.id
  loop
    exit when left_offset+left_cash<=0;
    part := least(left_offset,r.balance);
    if part>0 then
      insert into public.accounts_payable_payments(payable_id,payment_date,amount_jpy,credit_offset_jpy,
        target_closing_id,payment_group_id,memo,created_by,updated_by)
      values(r.id,p_payment_date,0,part,c.id,group_id,'赤伝・過払の相殺',auth.uid(),auth.uid());
      left_offset := left_offset-part;
    end if;
    part := least(left_cash,r.balance-part);
    if part>0 then
      insert into public.accounts_payable_payments(payable_id,payment_date,amount_jpy,bank_fee_jpy,
        target_closing_id,payment_group_id,reference_no,memo,created_by,updated_by)
      values(r.id,p_payment_date,part,fee,c.id,group_id,nullif(trim(p_reference_no),''),nullif(trim(p_memo),''),auth.uid(),auth.uid());
      left_cash := left_cash-part;
      fee := 0;
    end if;
  end loop;
  if left_cash<>0 or left_offset<>0 or (select sum(credit_offset_jpy) from public.accounts_payable_payments where payment_group_id=group_id)<>0 then
    raise exception '支払・相殺額を配賦できませんでした。';
  end if;
  result_data := jsonb_build_object('payment_group_id',group_id,'allocated_amount_jpy',cash,
    'credit_offset_jpy',offset_total,'remaining_balance_jpy',debit-credit-cash);
  update public.accounts_payable_settlements set result=result_data where id=group_id;
  return result_data;
end;
$$;

-- Old clients must also reject gross payments that ignore a credit note.
create or replace function public.register_accounts_payable_closing_payment(
  p_closing_id uuid,p_payment_date date,p_amount_jpy numeric,p_bank_fee_jpy numeric default 0,
  p_reference_no text default null,p_memo text default null
)
returns jsonb language sql security invoker set search_path = public, pg_temp as $$
  select public.register_accounts_payable_net_payment(p_closing_id,p_payment_date,p_amount_jpy,
    p_bank_fee_jpy,p_reference_no,p_memo,null);
$$;

create or replace function public.cancel_accounts_payable_payment_group(p_group_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.accounts_payable_settlements;
begin
  if auth.uid() is null or not public.is_master_admin() then raise exception '支払を取り消せるのは管理者のみです。'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ap-request:' || p_group_id::text,0));
  select * into s from public.accounts_payable_settlements where id=p_group_id;
  if s.cancelled_at is not null then return jsonb_build_object('cancelled',true); end if;
  perform c.id from public.accounts_payable_closings c where c.id in (
    select target_closing_id from public.accounts_payable_payments where payment_group_id=p_group_id
  ) order by c.id for update;
  perform p.id from public.accounts_payable p where p.id in (
    select payable_id from public.accounts_payable_payments where payment_group_id=p_group_id
  ) order by p.invoice_date,p.created_at,p.id for update;
  if exists (select 1 from public.accounts_payable_payments m join public.accounts_payable_closings c on c.id=m.closing_id
    where m.payment_group_id=p_group_id and c.status='closed') then
    raise exception '次の買掛締めに含まれた支払は取り消せません。先に該当する締めを解除してください。';
  end if;
  delete from public.accounts_payable_payments where payment_group_id=p_group_id;
  update public.accounts_payable_settlements set cancelled_by=auth.uid(),cancelled_at=now() where id=p_group_id;
  return jsonb_build_object('cancelled',true);
end;
$$;

revoke all on function public.register_accounts_payable_net_payment(uuid,date,numeric,numeric,text,text,uuid) from public,anon;
grant execute on function public.register_accounts_payable_net_payment(uuid,date,numeric,numeric,text,text,uuid) to authenticated;
revoke all on function public.register_accounts_payable_closing_payment(uuid,date,numeric,numeric,text,text) from public,anon;
grant execute on function public.register_accounts_payable_closing_payment(uuid,date,numeric,numeric,text,text) to authenticated;
revoke all on function public.cancel_accounts_payable_payment_group(uuid) from public,anon;
grant execute on function public.cancel_accounts_payable_payment_group(uuid) to authenticated;
do $$ begin
  if to_regprocedure('public.log_business_audit_event()') is not null then
    drop trigger if exists trg_business_audit on public.accounts_payable_settlements;
    create trigger trg_business_audit after insert or update or delete on public.accounts_payable_settlements
      for each row execute function public.log_business_audit_event();
  end if;
end $$;
-- Extend only the table list in the installed snapshot functions. Preserve their
-- current retention, permissions and other production-specific behavior.
do $$
declare f record; definition text;
begin
  for f in select oid from pg_proc where pronamespace='public'::regnamespace
    and proname in ('run_scheduled_business_snapshot','create_business_snapshot') loop
    definition := pg_get_functiondef(f.oid);
    if strpos(definition,'''accounts_payable_settlements''')=0
       and strpos(definition,'''accounts_payable_payments''')>0 then
      execute replace(definition,'''accounts_payable_payments''',
        '''accounts_payable_payments'',''accounts_payable_settlements''');
    end if;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
