-- 売上参照から、現場確定・赤伝等・過去取込のすべてを管理者修正できるようにします。
-- sales-correction-provisional-lock-migration.sql と pending-sales-integration-migration.sql
-- の実行後に、Supabase Dashboard > SQL Editor で1回実行してください。

alter table public.sales_correction_log
  drop constraint if exists sales_correction_log_action_type_check;

alter table public.sales_correction_log
  add constraint sales_correction_log_action_type_check
  check (
    action_type in (
      'sales_record',
      'historical_sales_record',
      'pending_entry',
      'shipping_fee',
      'provisional_lock',
      'provisional_unlock'
    )
  );

alter table public.sales_correction_log
  add column if not exists historical_sales_record_id uuid
    references public.historical_sales_records(id) on delete set null,
  add column if not exists pending_entry_id uuid
    references public.pending_entries(id) on delete set null;

create index if not exists idx_sales_correction_log_historical
  on public.sales_correction_log(historical_sales_record_id, changed_at desc);

create index if not exists idx_sales_correction_log_pending
  on public.sales_correction_log(pending_entry_id, changed_at desc);

create or replace function public.admin_correct_historical_sales_record(
  p_historical_sales_record_id uuid,
  p_work_date date,
  p_importer_code text,
  p_store_name text,
  p_product_id text,
  p_product_name text,
  p_origin text,
  p_input_qty numeric,
  p_input_unit text,
  p_net_weight numeric,
  p_unit_price numeric,
  p_amount numeric,
  p_memo text,
  p_reason text
)
returns public.historical_sales_records
language plpgsql
security definer
set search_path = public
as $$
declare
  old_row public.historical_sales_records;
  new_row public.historical_sales_records;
  normalized_importer text := public.canonical_importer_code(p_importer_code);
  corrected_amount numeric;
begin
  if not public.is_master_admin() then
    raise exception '過去売上を修正できるのは管理者のみです。';
  end if;
  if trim(coalesce(p_reason, '')) = '' then
    raise exception '修正理由を入力してください。';
  end if;
  if p_work_date is null or normalized_importer = '' then
    raise exception '日付と輸入社コードを入力してください。';
  end if;
  if p_input_qty is not null and p_input_qty < 0 then
    raise exception '数量は0以上で入力してください。';
  end if;
  if p_net_weight is not null and p_net_weight < 0 then
    raise exception 'NET重量は0以上で入力してください。';
  end if;
  if p_unit_price is not null and p_unit_price < 0 then
    raise exception '単価は0以上で入力してください。';
  end if;

  select *
  into old_row
  from public.historical_sales_records
  where id = p_historical_sales_record_id
  for update;

  if old_row.id is null then
    raise exception '修正する過去売上が見つかりません。';
  end if;

  corrected_amount := case
    when coalesce(old_row.is_stockout, false) then null
    when p_amount is not null then round(p_amount, 2)
    when p_input_qty is not null and p_unit_price is not null
      then round(p_input_qty * p_unit_price, 2)
    else null
  end;

  update public.historical_sales_records
  set
    finalized_at = p_work_date::timestamp at time zone 'UTC',
    importer_code = normalized_importer,
    store_name = nullif(trim(coalesce(p_store_name, '')), ''),
    product_id = nullif(trim(coalesce(p_product_id, '')), ''),
    product_name = nullif(trim(coalesce(p_product_name, '')), ''),
    origin = nullif(trim(coalesce(p_origin, '')), ''),
    input_qty = p_input_qty,
    input_unit = nullif(trim(coalesce(p_input_unit, '')), ''),
    net_weight = p_net_weight,
    unit_price = p_unit_price,
    amount = corrected_amount,
    memo = nullif(trim(coalesce(p_memo, '')), '')
  where id = p_historical_sales_record_id
  returning * into new_row;

  insert into public.sales_correction_log (
    action_type,
    historical_sales_record_id,
    importer_code,
    old_values,
    new_values,
    reason,
    changed_by
  )
  values (
    'historical_sales_record',
    new_row.id,
    new_row.importer_code,
    to_jsonb(old_row),
    to_jsonb(new_row),
    trim(p_reason),
    auth.uid()
  );

  return new_row;
end;
$$;

create or replace function public.admin_correct_pending_entry(
  p_pending_entry_id uuid,
  p_work_date date,
  p_importer_code text,
  p_customer_name text,
  p_product_code text,
  p_description text,
  p_qty numeric,
  p_unit text,
  p_unit_price numeric,
  p_amount numeric,
  p_memo text,
  p_reason text
)
returns public.pending_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  old_row public.pending_entries;
  new_row public.pending_entries;
  receivable_row public.accounts_receivable;
  normalized_importer text := public.canonical_importer_code(p_importer_code);
  normalized_amount numeric;
  importer_name text;
begin
  if not public.is_master_admin() then
    raise exception '赤伝・調整を修正できるのは管理者のみです。';
  end if;
  if trim(coalesce(p_reason, '')) = '' then
    raise exception '修正理由を入力してください。';
  end if;
  if p_work_date is null or normalized_importer = '' then
    raise exception '日付と輸入社コードを入力してください。';
  end if;
  if trim(coalesce(p_customer_name, '')) = '' then
    raise exception '得意先名を入力してください。';
  end if;
  if trim(coalesce(p_description, '')) = '' then
    raise exception '商品名・内容を入力してください。';
  end if;
  if p_qty is not null and p_qty < 0 then
    raise exception '数量は0以上で入力してください。';
  end if;
  if p_unit_price is not null and p_unit_price < 0 then
    raise exception '単価は0以上で入力してください。';
  end if;
  if p_amount is null then
    raise exception '金額を入力してください。';
  end if;

  select *
  into old_row
  from public.pending_entries
  where id = p_pending_entry_id
  for update;

  if old_row.id is null then
    raise exception '修正する赤伝・調整が見つかりません。';
  end if;
  if old_row.status <> 'applied' or old_row.applied_invoice_no is null then
    raise exception '売上反映前の伝票は未処理伝票画面から編集してください。';
  end if;

  select *
  into receivable_row
  from public.accounts_receivable
  where source_key = 'pending:' || old_row.id::text
  for update;

  if receivable_row.id is not null and receivable_row.closing_id is not null then
    raise exception '請求締め済みの赤伝・調整です。先に請求締めを解除してください。';
  end if;
  if receivable_row.id is not null and exists (
    select 1
    from public.accounts_receivable_payments
    where receivable_id = receivable_row.id
  ) then
    raise exception '入金処理済みの赤伝・調整です。先に入金履歴を確認してください。';
  end if;

  normalized_amount := round(
    case
      when old_row.entry_type in ('credit_note', 'discount') and p_amount > 0
        then -p_amount
      else p_amount
    end,
    2
  );

  select m.importer_name
  into importer_name
  from public.importer_master m
  where public.canonical_importer_code(m.importer_code) = normalized_importer
  order by case when trim(m.importer_code) ~ '^[0-9]+$' then 0 else 1 end
  limit 1;

  update public.pending_entries
  set
    applied_work_date = p_work_date,
    importer_code = normalized_importer,
    importer_name_snapshot = coalesce(nullif(trim(importer_name), ''), importer_name_snapshot),
    customer_name_snapshot = trim(p_customer_name),
    product_code = nullif(trim(coalesce(p_product_code, '')), ''),
    product_name_snapshot = trim(p_description),
    description = trim(p_description),
    qty = p_qty,
    unit = nullif(trim(coalesce(p_unit, '')), ''),
    unit_price = p_unit_price,
    amount = normalized_amount,
    memo = nullif(trim(coalesce(p_memo, '')), '')
  where id = p_pending_entry_id
  returning * into new_row;

  insert into public.sales_correction_log (
    action_type,
    pending_entry_id,
    importer_code,
    old_values,
    new_values,
    reason,
    changed_by
  )
  values (
    'pending_entry',
    new_row.id,
    new_row.importer_code,
    to_jsonb(old_row),
    to_jsonb(new_row),
    trim(p_reason),
    auth.uid()
  );

  return new_row;
end;
$$;

revoke all on function public.admin_correct_historical_sales_record(
  uuid, date, text, text, text, text, text, numeric, text, numeric, numeric, numeric, text, text
) from public;
revoke all on function public.admin_correct_pending_entry(
  uuid, date, text, text, text, text, numeric, text, numeric, numeric, text, text
) from public;

grant execute on function public.admin_correct_historical_sales_record(
  uuid, date, text, text, text, text, text, numeric, text, numeric, numeric, numeric, text, text
) to authenticated;
grant execute on function public.admin_correct_pending_entry(
  uuid, date, text, text, text, text, numeric, text, numeric, numeric, text, text
) to authenticated;

notify pgrst, 'reload schema';
