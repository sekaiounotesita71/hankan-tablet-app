-- Weekly closing uses an anchor date, not a day of the month.
-- No existing balances, payments, closings or due dates are rewritten here.
begin;

alter table public.accounts_payable_supplier_profiles
  add column if not exists closing_anchor_date date,
  add column if not exists payment_days_after_closing smallint
    check (payment_days_after_closing between 0 and 365);

create or replace function public.accounts_payable_weekly_closing_date(
  p_date date, p_anchor date
)
returns date
language sql immutable strict
set search_path = public, pg_temp
as $$
  select p_anchor + (ceil((p_date - p_anchor)::numeric / 7)::integer * 7);
$$;

-- Keep the existing sync RPC and its monthly/cash behavior intact.
create or replace function public.apply_accounts_payable_weekly_due_date()
returns trigger
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  profile public.accounts_payable_supplier_profiles;
begin
  if new.source_type <> 'purchase' or new.closing_id is not null then return new; end if;
  if tg_op = 'UPDATE' and old.closing_id is not null then return new; end if;
  select * into profile from public.accounts_payable_supplier_profiles
  where supplier_code = new.supplier_code;
  if profile.payment_mode = 'credit' and profile.closing_day = 7
    and profile.closing_anchor_date is not null
    and profile.payment_days_after_closing is not null then
    new.due_date := public.accounts_payable_weekly_closing_date(
      new.invoice_date, profile.closing_anchor_date
    ) + profile.payment_days_after_closing;
  end if;
  return new;
end;
$$;

create or replace trigger trg_accounts_payable_weekly_due
before insert or update of invoice_date, supplier_code, due_date
on public.accounts_payable
for each row execute function public.apply_accounts_payable_weekly_due_date();

-- Old clients cannot accidentally submit a monthly range for weekly suppliers.
create or replace function public.validate_accounts_payable_weekly_closing()
returns trigger
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  profile public.accounts_payable_supplier_profiles;
  pending_date date;
begin
  if new.status <> 'closed' then return new; end if;
  select * into profile from public.accounts_payable_supplier_profiles
  where supplier_code = new.supplier_code;
  if profile.payment_mode = 'credit' and profile.closing_day = 7 then
    if profile.closing_anchor_date is null or profile.payment_days_after_closing is null then
      raise exception '7日間隔の基準締め日と支払日数をマスタで設定してください。';
    end if;
    if new.period_from <> new.period_to - 6
      or public.accounts_payable_weekly_closing_date(new.period_to,profile.closing_anchor_date) <> new.period_to then
      raise exception '7日間隔の締め期間が正しくありません。画面を再読み込みしてください。';
    end if;
    if new.due_date is distinct from new.period_to + profile.payment_days_after_closing then
      raise exception '支払期限が7日間隔の支払条件と一致しません。再読み込みしてください。';
    end if;
    select min(p.invoice_date) into pending_date
    from public.accounts_payable p
    where p.supplier_code = new.supplier_code and p.source_type <> 'opening'
      and p.closing_id is null and p.invoice_date < new.period_from
      and not exists (
        select 1 from public.accounts_payable_closings c
        where c.supplier_code = p.supplier_code and c.status = 'closed'
          and p.invoice_date between c.period_from and c.period_to
      );
    if pending_date is not null then
      raise exception '先に%締めを完了してください。',
        public.accounts_payable_weekly_closing_date(pending_date,profile.closing_anchor_date);
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger trg_accounts_payable_weekly_closing
before insert or update of period_from, period_to, due_date, status
on public.accounts_payable_closings
for each row execute function public.validate_accounts_payable_weekly_closing();

revoke all on function public.accounts_payable_weekly_closing_date(date,date) from public,anon;
revoke all on function public.apply_accounts_payable_weekly_due_date() from public,anon;
revoke all on function public.validate_accounts_payable_weekly_closing() from public,anon;
grant execute on function public.accounts_payable_weekly_closing_date(date,date) to authenticated;
notify pgrst, 'reload schema';
commit;
