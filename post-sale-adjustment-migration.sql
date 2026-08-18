-- 確定後に判明した赤伝・訂正・追加請求・値引き・送料調整を、
-- 売上参照と売掛へ同時に追加します。
-- pending-sales-integration-migration.sql と sales-correction-all-sources-migration.sql
-- の実行後に、Supabase SQL Editorで1回実行してください。

create or replace function public.admin_create_post_sale_entry(
  p_entry_type text,
  p_work_date date,
  p_importer_code text,
  p_customer_code text,
  p_customer_name text,
  p_product_code text,
  p_description text,
  p_qty numeric,
  p_unit text,
  p_unit_price numeric,
  p_amount numeric,
  p_reason text,
  p_memo text
)
returns public.pending_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  created_row public.pending_entries;
  normalized_importer text := public.canonical_importer_code(p_importer_code);
  normalized_amount numeric;
  importer_name text;
  invoice_no text;
begin
  if not public.is_master_admin() then
    raise exception '確定後の売上を追加できるのは管理者のみです。';
  end if;

  if p_entry_type not in ('credit_note', 'correction', 'extra_charge', 'discount', 'shipping_adjustment') then
    raise exception '処理区分を確認してください。';
  end if;
  if p_work_date is null then
    raise exception '反映日を入力してください。';
  end if;
  if normalized_importer !~ '^[0-9]{1,3}$' then
    raise exception '輸入社マスタに登録済みの輸入社を選択してください。';
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
  if p_amount is null or abs(p_amount) <= 0.005 then
    raise exception '金額は0以外で入力してください。';
  end if;
  if trim(coalesce(p_reason, '')) = '' then
    raise exception '登録理由を入力してください。';
  end if;

  normalized_amount := round(
    case
      when p_entry_type in ('credit_note', 'discount') then -abs(p_amount)
      when p_entry_type = 'extra_charge' then abs(p_amount)
      else p_amount
    end,
    2
  );

  select m.importer_name
    into importer_name
  from public.importer_master m
  where public.canonical_importer_code(m.importer_code) = normalized_importer
  order by case when trim(m.importer_code) ~ '^[0-9]+$' then 0 else 1 end,
           m.importer_code
  limit 1;

  if trim(coalesce(importer_name, '')) = '' then
    raise exception '輸入社マスタの名称を確認してください。';
  end if;

  invoice_no := to_char(p_work_date, 'YYYYMMDD') || lpad(normalized_importer, 3, '0');

  insert into public.pending_entries (
    entry_type,
    status,
    entry_date,
    planned_date,
    importer_code,
    importer_name_snapshot,
    customer_code,
    customer_name_snapshot,
    product_code,
    product_name_snapshot,
    description,
    qty,
    unit,
    unit_price,
    amount,
    reason,
    memo,
    source_type,
    source_ref,
    applied_invoice_no,
    applied_work_date,
    applied_at,
    applied_by,
    created_by
  )
  values (
    p_entry_type,
    'applied',
    p_work_date,
    null,
    normalized_importer,
    trim(importer_name),
    nullif(trim(coalesce(p_customer_code, '')), ''),
    trim(p_customer_name),
    nullif(trim(coalesce(p_product_code, '')), ''),
    trim(p_description),
    trim(p_description),
    p_qty,
    nullif(trim(coalesce(p_unit, '')), ''),
    p_unit_price,
    normalized_amount,
    trim(p_reason),
    nullif(trim(coalesce(p_memo, '')), ''),
    'system',
    'post-sale-adjustment',
    invoice_no,
    p_work_date,
    now(),
    auth.uid(),
    auth.uid()
  )
  returning * into created_row;

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
    created_row.id,
    created_row.importer_code,
    '{}'::jsonb,
    to_jsonb(created_row),
    trim(p_reason),
    auth.uid()
  );

  return created_row;
end;
$$;

revoke all on function public.admin_create_post_sale_entry(
  text, date, text, text, text, text, text, numeric, text, numeric, numeric, text, text
) from public;

grant execute on function public.admin_create_post_sale_entry(
  text, date, text, text, text, text, text, numeric, text, numeric, numeric, text, text
) to authenticated;

notify pgrst, 'reload schema';
