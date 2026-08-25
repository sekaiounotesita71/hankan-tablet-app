-- Invoice・売上・売掛でJPY明細を同じ1円単位に固定します。
-- 明細ごとに四捨五入してから合計するため、Excel表示額との1円差を防ぎます。
-- 既存データは、請求締め・入金がない売掛だけを再計算します。

begin;

create or replace function public.normalize_sales_record_jpy_amount()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(new.is_stockout, false) then
    new.amount := null;
  elsif new.input_qty is not null and new.unit_price is not null then
    new.amount := round(new.input_qty * new.unit_price, 0);
  elsif new.amount is not null then
    new.amount := round(new.amount, 0);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_normalize_sales_record_jpy_amount on public.sales_records;
create trigger trg_normalize_sales_record_jpy_amount
before insert or update on public.sales_records
for each row execute function public.normalize_sales_record_jpy_amount();

create or replace function public.normalize_pending_entry_jpy_amount()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.amount is not null then
    new.amount := round(new.amount, 0);
  elsif new.qty is not null and new.unit_price is not null then
    new.amount := round(new.qty * new.unit_price, 0);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_normalize_pending_entry_jpy_amount on public.pending_entries;
create trigger trg_normalize_pending_entry_jpy_amount
before insert or update on public.pending_entries
for each row execute function public.normalize_pending_entry_jpy_amount();

create or replace function public.normalize_accounts_receivable_jpy_amount()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if upper(coalesce(new.currency, 'JPY')) = 'JPY' then
    new.net_sales_jpy := round(coalesce(new.net_sales_jpy, 0), 0);
    new.shipping_amount_jpy := round(coalesce(new.shipping_amount_jpy, 0), 0);
    new.adjustment_amount_jpy := round(coalesce(new.adjustment_amount_jpy, 0), 0);
    if new.source_type = 'sales' then
      new.amount_jpy := new.net_sales_jpy + new.shipping_amount_jpy + new.adjustment_amount_jpy;
    else
      new.amount_jpy := round(coalesce(new.amount_jpy, 0), 0);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_normalize_accounts_receivable_jpy_amount on public.accounts_receivable;
create trigger trg_normalize_accounts_receivable_jpy_amount
before insert or update on public.accounts_receivable
for each row execute function public.normalize_accounts_receivable_jpy_amount();

-- sales_records.amount は数量・単価から再計算できる派生値です。
-- 確定済み行の保護トリガーだけを同一トランザクション内で一時停止します。
do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.sales_records'::regclass
      and tgname = 'trg_guard_sales_record_parent'
      and not tgisinternal
  ) then
    execute 'alter table public.sales_records disable trigger trg_guard_sales_record_parent';
  end if;
end;
$$;

update public.sales_records
set amount = case
  when coalesce(is_stockout, false) then null
  when input_qty is not null and unit_price is not null then round(input_qty * unit_price, 0)
  when amount is not null then round(amount, 0)
  else null
end
where amount is distinct from case
  when coalesce(is_stockout, false) then null
  when input_qty is not null and unit_price is not null then round(input_qty * unit_price, 0)
  when amount is not null then round(amount, 0)
  else null
end;

do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.sales_records'::regclass
      and tgname = 'trg_guard_sales_record_parent'
      and not tgisinternal
  ) then
    execute 'alter table public.sales_records enable trigger trg_guard_sales_record_parent';
  end if;
end;
$$;

update public.pending_entries
set amount = round(amount, 0)
where amount is not null
  and amount <> round(amount, 0);

with expected as (
  select
    session_id,
    public.canonical_importer_code(coalesce(importer_code, importer_id, '')) as importer_code,
    sum(round(coalesce(amount, input_qty * unit_price, 0), 0)) as net_sales
  from public.sales_records
  where coalesce(is_stockout, false) = false
    and coalesce(importer_code, importer_id, '') <> ''
  group by session_id, public.canonical_importer_code(coalesce(importer_code, importer_id, ''))
)
update public.accounts_receivable receivable
set
  net_sales_jpy = expected.net_sales,
  shipping_amount_jpy = round(receivable.shipping_amount_jpy, 0),
  adjustment_amount_jpy = round(receivable.adjustment_amount_jpy, 0),
  amount_jpy = expected.net_sales
    + round(receivable.shipping_amount_jpy, 0)
    + round(receivable.adjustment_amount_jpy, 0),
  updated_at = now()
from expected
where receivable.source_type = 'sales'
  and receivable.source_session_id = expected.session_id
  and public.canonical_importer_code(receivable.importer_code) = expected.importer_code
  and receivable.closing_id is null
  and not exists (
    select 1
    from public.accounts_receivable_payments payment
    where payment.receivable_id = receivable.id
  )
  and (
    receivable.net_sales_jpy is distinct from expected.net_sales
    or receivable.shipping_amount_jpy <> round(receivable.shipping_amount_jpy, 0)
    or receivable.adjustment_amount_jpy <> round(receivable.adjustment_amount_jpy, 0)
    or receivable.amount_jpy is distinct from expected.net_sales
      + round(receivable.shipping_amount_jpy, 0)
      + round(receivable.adjustment_amount_jpy, 0)
  );

update public.accounts_receivable receivable
set
  net_sales_jpy = round(receivable.net_sales_jpy, 0),
  shipping_amount_jpy = round(receivable.shipping_amount_jpy, 0),
  adjustment_amount_jpy = round(receivable.adjustment_amount_jpy, 0),
  amount_jpy = round(receivable.amount_jpy, 0),
  updated_at = now()
where upper(coalesce(receivable.currency, 'JPY')) = 'JPY'
  and receivable.closing_id is null
  and not exists (
    select 1
    from public.accounts_receivable_payments payment
    where payment.receivable_id = receivable.id
  )
  and (
    receivable.net_sales_jpy <> round(receivable.net_sales_jpy, 0)
    or receivable.shipping_amount_jpy <> round(receivable.shipping_amount_jpy, 0)
    or receivable.adjustment_amount_jpy <> round(receivable.adjustment_amount_jpy, 0)
    or receivable.amount_jpy <> round(receivable.amount_jpy, 0)
  );

commit;

notify pgrst, 'reload schema';

-- 実行後の確認用。
select
  (select count(*) from public.sales_records where amount is not null and amount <> round(amount, 0)) as sales_rows_with_fraction,
  (select count(*) from public.pending_entries where amount is not null and amount <> round(amount, 0)) as pending_rows_with_fraction,
  (select count(*) from public.accounts_receivable where upper(coalesce(currency, 'JPY')) = 'JPY' and amount_jpy <> round(amount_jpy, 0)) as receivable_rows_with_fraction;
