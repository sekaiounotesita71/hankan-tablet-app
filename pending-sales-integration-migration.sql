-- Invoiceへ反映した赤伝・訂正・追加請求・値引き・送料調整を
-- 売上参照と売掛管理へ一度だけ連動させます。
-- pending-entries-migration.sql と accounts-receivable-migration.sql の実行後に、
-- Supabase Dashboard > SQL Editor で実行してください。

alter table public.pending_entries
  add column if not exists applied_work_date date;

create index if not exists idx_pending_entries_applied_work_date
  on public.pending_entries(applied_work_date desc)
  where status = 'applied' and applied_invoice_no is not null;

-- 既存のInvoice反映済み伝票は、Invoice番号の日付を優先して補完します。
update public.pending_entries
set applied_work_date = coalesce(
  case
    when applied_invoice_no ~ '^INV-[0-9]{8}-'
      then to_date(substring(applied_invoice_no from '^INV-([0-9]{8})-'), 'YYYYMMDD')
    else null
  end,
  planned_date,
  entry_date
)
where status = 'applied'
  and applied_invoice_no is not null
  and applied_work_date is null;

create or replace function public.pending_entry_signed_amount(
  p_entry_type text,
  p_amount numeric
)
returns numeric
language sql
immutable
as $$
  select round(
    case
      when p_entry_type in ('credit_note', 'discount') and coalesce(p_amount, 0) > 0
        then -coalesce(p_amount, 0)
      else coalesce(p_amount, 0)
    end,
    2
  );
$$;

create or replace function public.pending_entry_type_label(
  p_entry_type text
)
returns text
language sql
immutable
as $$
  select case p_entry_type
    when 'advance_order' then '先行受注'
    when 'credit_note' then '赤伝'
    when 'correction' then '訂正'
    when 'extra_charge' then '追加請求'
    when 'discount' then '値引き'
    when 'shipping_adjustment' then '送料調整'
    else coalesce(p_entry_type, '調整')
  end;
$$;

create or replace function public.remove_pending_entry_receivable(
  p_pending_entry_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id uuid;
  target_closing_id uuid;
begin
  select id, closing_id
    into target_id, target_closing_id
  from public.accounts_receivable
  where source_key = 'pending:' || p_pending_entry_id::text
  for update;

  if target_id is null then
    return;
  end if;

  if target_closing_id is not null then
    raise exception '請求締め済みの赤伝・調整です。先に請求締めを解除してください。';
  end if;

  if exists (
    select 1
    from public.accounts_receivable_payments
    where receivable_id = target_id
  ) then
    raise exception '入金処理済みの赤伝・調整です。先に入金履歴を確認してください。';
  end if;

  delete from public.accounts_receivable
  where id = target_id;
end;
$$;

create or replace function public.sync_pending_entry_receivable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  signed_amount numeric;
  effective_date date;
  normalized_importer text;
  customer_names jsonb;
  memo_text text;
begin
  if tg_op = 'DELETE' then
    if old.status = 'applied' and old.applied_invoice_no is not null then
      perform public.remove_pending_entry_receivable(old.id);
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE'
     and old.status = 'applied'
     and old.applied_invoice_no is not null
     and (new.status <> 'applied' or new.applied_invoice_no is null) then
    perform public.remove_pending_entry_receivable(old.id);
  end if;

  if new.status <> 'applied' or new.applied_invoice_no is null then
    return new;
  end if;

  signed_amount := public.pending_entry_signed_amount(new.entry_type, new.amount);
  effective_date := coalesce(new.applied_work_date, new.planned_date, new.entry_date, current_date);
  normalized_importer := upper(regexp_replace(coalesce(new.importer_code, ''), '[[:space:]_-]+', '', 'g'));
  customer_names := case
    when trim(coalesce(new.customer_name_snapshot, '')) = '' then '[]'::jsonb
    else jsonb_build_array(trim(new.customer_name_snapshot))
  end;
  memo_text := concat_ws(
    ' / ',
    '【' || public.pending_entry_type_label(new.entry_type) || '】' || new.description,
    nullif(trim(coalesce(new.reason, '')), ''),
    nullif(trim(coalesce(new.memo, '')), '')
  );

  if normalized_importer = '' then
    raise exception '赤伝・調整の輸入社コードがありません。';
  end if;

  if abs(signed_amount) <= 0.005 then
    perform public.remove_pending_entry_receivable(new.id);
    return new;
  end if;

  insert into public.accounts_receivable (
    source_key,
    source_type,
    importer_code,
    importer_name,
    customer_code,
    customer_name,
    customer_names,
    invoice_no,
    invoice_date,
    currency,
    net_sales_jpy,
    shipping_amount_jpy,
    adjustment_amount_jpy,
    amount_jpy,
    memo,
    created_by,
    updated_by
  )
  values (
    'pending:' || new.id::text,
    'adjustment',
    normalized_importer,
    nullif(trim(coalesce(new.importer_name_snapshot, '')), ''),
    nullif(trim(coalesce(new.customer_code, '')), ''),
    nullif(trim(coalesce(new.customer_name_snapshot, '')), ''),
    customer_names,
    new.applied_invoice_no,
    effective_date,
    'JPY',
    0,
    0,
    signed_amount,
    signed_amount,
    memo_text,
    coalesce(new.applied_by, new.created_by, auth.uid()),
    coalesce(new.applied_by, auth.uid())
  )
  on conflict (source_key)
  do update set
    importer_code = excluded.importer_code,
    importer_name = excluded.importer_name,
    customer_code = excluded.customer_code,
    customer_name = excluded.customer_name,
    customer_names = excluded.customer_names,
    invoice_no = excluded.invoice_no,
    invoice_date = excluded.invoice_date,
    adjustment_amount_jpy = excluded.adjustment_amount_jpy,
    amount_jpy = excluded.amount_jpy,
    memo = excluded.memo,
    updated_by = excluded.updated_by;

  return new;
end;
$$;

drop trigger if exists trg_sync_pending_entry_receivable
  on public.pending_entries;
create trigger trg_sync_pending_entry_receivable
after insert or update or delete on public.pending_entries
for each row execute function public.sync_pending_entry_receivable();

-- トリガー作成前にInvoice反映済みだった伝票も売掛へ取り込みます。
insert into public.accounts_receivable (
  source_key,
  source_type,
  importer_code,
  importer_name,
  customer_code,
  customer_name,
  customer_names,
  invoice_no,
  invoice_date,
  currency,
  net_sales_jpy,
  shipping_amount_jpy,
  adjustment_amount_jpy,
  amount_jpy,
  memo,
  created_by,
  updated_by
)
select
  'pending:' || p.id::text,
  'adjustment',
  upper(regexp_replace(p.importer_code, '[[:space:]_-]+', '', 'g')),
  nullif(trim(coalesce(p.importer_name_snapshot, '')), ''),
  nullif(trim(coalesce(p.customer_code, '')), ''),
  nullif(trim(coalesce(p.customer_name_snapshot, '')), ''),
  case
    when trim(coalesce(p.customer_name_snapshot, '')) = '' then '[]'::jsonb
    else jsonb_build_array(trim(p.customer_name_snapshot))
  end,
  p.applied_invoice_no,
  coalesce(p.applied_work_date, p.planned_date, p.entry_date),
  'JPY',
  0,
  0,
  public.pending_entry_signed_amount(p.entry_type, p.amount),
  public.pending_entry_signed_amount(p.entry_type, p.amount),
  concat_ws(
    ' / ',
    '【' || public.pending_entry_type_label(p.entry_type) || '】' || p.description,
    nullif(trim(coalesce(p.reason, '')), ''),
    nullif(trim(coalesce(p.memo, '')), '')
  ),
  coalesce(p.applied_by, p.created_by),
  p.applied_by
from public.pending_entries p
where p.status = 'applied'
  and p.applied_invoice_no is not null
  and abs(public.pending_entry_signed_amount(p.entry_type, p.amount)) > 0.005
on conflict (source_key)
do update set
  importer_code = excluded.importer_code,
  importer_name = excluded.importer_name,
  customer_code = excluded.customer_code,
  customer_name = excluded.customer_name,
  customer_names = excluded.customer_names,
  invoice_no = excluded.invoice_no,
  invoice_date = excluded.invoice_date,
  adjustment_amount_jpy = excluded.adjustment_amount_jpy,
  amount_jpy = excluded.amount_jpy,
  memo = excluded.memo,
  updated_by = excluded.updated_by;

revoke all on function public.remove_pending_entry_receivable(uuid) from public;
revoke all on function public.sync_pending_entry_receivable() from public;

notify pgrst, 'reload schema';
