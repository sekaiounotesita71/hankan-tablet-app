-- Canonicalize sales receivable keys and reconcile legacy importer-name rows.
-- Run after sales-correction-provisional-lock-migration.sql.

begin;

create table if not exists public.accounts_receivable_reconciliation_log (
  id uuid primary key default gen_random_uuid(),
  reconciliation_key text not null,
  reason text not null,
  receivable_id uuid not null,
  row_data jsonb not null,
  payment_data jsonb not null default '[]'::jsonb,
  captured_at timestamptz not null default now(),
  captured_by uuid default auth.uid(),
  unique (reconciliation_key, receivable_id)
);

alter table public.accounts_receivable_reconciliation_log enable row level security;

drop policy if exists "admins can read receivable reconciliation log"
  on public.accounts_receivable_reconciliation_log;
create policy "admins can read receivable reconciliation log"
on public.accounts_receivable_reconciliation_log for select to authenticated
using (public.is_master_admin());

revoke insert, update, delete on public.accounts_receivable_reconciliation_log from authenticated;
grant select on public.accounts_receivable_reconciliation_log to authenticated;

create or replace function public.rebuild_session_accounts_receivable(
  p_session_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  session_row public.work_sessions;
  importer_count integer := 0;
begin
  select *
  into session_row
  from public.work_sessions
  where id = p_session_id
  for update;

  if session_row.id is null then
    raise exception '対象作業が見つかりません。';
  end if;

  if exists (
    select 1
    from public.accounts_receivable r
    where r.source_session_id = p_session_id
      and r.closing_id is not null
  ) then
    raise exception '請求締め済みの売掛があります。先に請求締めを解除してください。';
  end if;

  if exists (
    select 1
    from public.accounts_receivable r
    join public.accounts_receivable_payments p on p.receivable_id = r.id
    where r.source_session_id = p_session_id
  ) then
    raise exception '入金登録済みの売掛があります。先に入金履歴を確認してください。';
  end if;

  select count(distinct public.canonical_importer_code(coalesce(importer_code, importer_id, '')))
  into importer_count
  from public.sales_records
  where session_id = p_session_id
    and coalesce(is_stockout, false) = false
    and coalesce(importer_code, importer_id, '') <> '';

  with grouped as (
    select
      public.canonical_importer_code(coalesce(importer_code, importer_id, '')) as importer_code,
      min(work_date) as invoice_date,
      sum(coalesce(amount, input_qty * unit_price, 0)) as net_sales,
      array_remove(
        array_agg(distinct nullif(trim(store_name), '') order by nullif(trim(store_name), '')),
        null
      ) as customers
    from public.sales_records
    where session_id = p_session_id
      and coalesce(is_stockout, false) = false
      and coalesce(importer_code, importer_id, '') <> ''
    group by public.canonical_importer_code(coalesce(importer_code, importer_id, ''))
  ),
  calculated as (
    select
      g.*,
      coalesce(
        (
          select (fee_item.value #>> '{}')::numeric
          from jsonb_each(coalesce(session_row.shipping_fees, '{}'::jsonb)) fee_item
          where public.canonical_importer_code(fee_item.key) = g.importer_code
          order by
            case
              when upper(regexp_replace(fee_item.key, '[[:space:]_-]+', '', 'g')) = g.importer_code then 0
              else 1
            end
          limit 1
        ),
        case when importer_count = 1 then session_row.shipping_fee else 0 end,
        0
      ) as shipping
    from grouped g
    where g.importer_code <> ''
  )
  insert into public.accounts_receivable (
    source_key,
    source_type,
    source_session_id,
    importer_code,
    importer_name,
    customer_name,
    customer_names,
    invoice_no,
    invoice_date,
    currency,
    net_sales_jpy,
    shipping_amount_jpy,
    amount_jpy,
    created_by,
    updated_by
  )
  select
    'sales:' || p_session_id::text || ':' || c.importer_code,
    'sales',
    p_session_id,
    c.importer_code,
    coalesce((
      select m.importer_name
      from public.importer_master m
      where public.canonical_importer_code(m.importer_code) = c.importer_code
      order by case when trim(m.importer_code) ~ '^[0-9]+$' then 0 else 1 end
      limit 1
    ), ''),
    case
      when coalesce(array_length(c.customers, 1), 0) = 0 then ''
      when array_length(c.customers, 1) = 1 then c.customers[1]
      else c.customers[1] || ' 他' || (array_length(c.customers, 1) - 1)::text || '件'
    end,
    to_jsonb(coalesce(c.customers, array[]::text[])),
    case
      when c.importer_code ~ '^[0-9]{1,3}$' then
        to_char(
          coalesce(
            c.invoice_date,
            session_row.work_date,
            timezone('Asia/Tokyo', coalesce(session_row.finalized_at, session_row.created_at, now()))::date
          ),
          'YYYYMMDD'
        ) || lpad(c.importer_code, 3, '0')
      else null
    end,
    coalesce(
      c.invoice_date,
      session_row.work_date,
      timezone('Asia/Tokyo', coalesce(session_row.finalized_at, session_row.created_at, now()))::date
    ),
    'JPY',
    round(coalesce(c.net_sales, 0), 2),
    round(coalesce(c.shipping, 0), 2),
    round(coalesce(c.net_sales, 0) + coalesce(c.shipping, 0), 2),
    auth.uid(),
    auth.uid()
  from calculated c
  where abs(coalesce(c.net_sales, 0) + coalesce(c.shipping, 0)) > 0.005
  on conflict (source_key)
  do update set
    importer_code = excluded.importer_code,
    importer_name = excluded.importer_name,
    customer_name = excluded.customer_name,
    customer_names = excluded.customer_names,
    invoice_no = coalesce(excluded.invoice_no, accounts_receivable.invoice_no),
    invoice_date = excluded.invoice_date,
    net_sales_jpy = excluded.net_sales_jpy,
    shipping_amount_jpy = excluded.shipping_amount_jpy,
    amount_jpy = excluded.amount_jpy,
    updated_by = auth.uid();

  -- Remove missing importer groups and legacy alias keys after the canonical row is saved.
  delete from public.accounts_receivable r
  where r.source_session_id = p_session_id
    and r.source_type = 'sales'
    and r.closing_id is null
    and not exists (
      select 1
      from public.accounts_receivable_payments p
      where p.receivable_id = r.id
    )
    and (
      not exists (
        select 1
        from public.sales_records s
        where s.session_id = p_session_id
          and coalesce(s.is_stockout, false) = false
          and public.canonical_importer_code(coalesce(s.importer_code, s.importer_id, ''))
            = public.canonical_importer_code(r.importer_code)
      )
      or r.source_key <>
        'sales:' || p_session_id::text || ':' || public.canonical_importer_code(r.importer_code)
    );
end;
$$;

create or replace function public.canonicalize_sales_receivable_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_importer text;
begin
  if new.source_type = 'sales' and new.source_session_id is not null then
    normalized_importer := public.canonical_importer_code(new.importer_code);
    if normalized_importer = '' then
      raise exception '売掛の輸入社コードが未設定です。';
    end if;
    new.importer_code := normalized_importer;
    new.source_key := 'sales:' || new.source_session_id::text || ':' || normalized_importer;
  end if;
  return new;
end;
$$;

-- Preserve every row that will be reconciled. This insert is idempotent.
with opening_cutoff as (
  select coalesce(max(invoice_date), '-infinity'::date) as cutoff
  from public.accounts_receivable
  where source_type = 'opening'
),
duplicate_groups as (
  select
    r.source_session_id,
    public.canonical_importer_code(r.importer_code) as importer_code
  from public.accounts_receivable r
  cross join opening_cutoff c
  where r.source_type = 'sales'
    and r.source_session_id is not null
    and r.invoice_date > c.cutoff
  group by r.source_session_id, public.canonical_importer_code(r.importer_code)
  having count(*) > 1
)
insert into public.accounts_receivable_reconciliation_log (
  reconciliation_key,
  reason,
  receivable_id,
  row_data,
  payment_data
)
select
  '20260818-importer-alias-reconciliation',
  '輸入社名キーと輸入社コードキーの二重売掛を売上原本へ統合',
  r.id,
  to_jsonb(r),
  coalesce((
    select jsonb_agg(to_jsonb(p) order by p.created_at)
    from public.accounts_receivable_payments p
    where p.receivable_id = r.id
  ), '[]'::jsonb)
from public.accounts_receivable r
join duplicate_groups d
  on d.source_session_id = r.source_session_id
 and d.importer_code = public.canonical_importer_code(r.importer_code)
on conflict (reconciliation_key, receivable_id) do nothing;

-- Rebuild only post-opening-balance sessions that actually contain duplicate keys.
do $$
declare
  target record;
  opening_cutoff date;
begin
  select coalesce(max(invoice_date), '-infinity'::date)
  into opening_cutoff
  from public.accounts_receivable
  where source_type = 'opening';

  for target in
    select distinct duplicate.source_session_id
    from (
      select r.source_session_id
      from public.accounts_receivable r
      where r.source_type = 'sales'
        and r.source_session_id is not null
        and r.invoice_date > opening_cutoff
      group by r.source_session_id, public.canonical_importer_code(r.importer_code)
      having count(*) > 1
    ) duplicate
  loop
    perform public.rebuild_session_accounts_receivable(target.source_session_id);
  end loop;
end;
$$;

drop trigger if exists trg_canonicalize_sales_receivable_key
  on public.accounts_receivable;
create trigger trg_canonicalize_sales_receivable_key
before insert or update of source_type, source_session_id, importer_code, source_key
on public.accounts_receivable
for each row execute function public.canonicalize_sales_receivable_key();

do $$
declare
  opening_cutoff date;
begin
  select coalesce(max(invoice_date), '-infinity'::date)
  into opening_cutoff
  from public.accounts_receivable
  where source_type = 'opening';

  if exists (
    select 1
    from public.accounts_receivable r
    where r.source_type = 'sales'
      and r.source_session_id is not null
      and r.invoice_date > opening_cutoff
    group by r.source_session_id, public.canonical_importer_code(r.importer_code)
    having count(*) > 1
  ) then
    raise exception '売掛の重複統合後チェックに失敗しました。変更はロールバックされます。';
  end if;
end;
$$;

revoke all on function public.canonicalize_sales_receivable_key() from public;

commit;
