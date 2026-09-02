-- Administrator correction for confirmed domestic sales.
-- Run after domestic-sales-migration.sql. The billing-closing migration is optional.

begin;

alter table public.domestic_sales
  add column if not exists corrected_by uuid references auth.users(id) on delete set null,
  add column if not exists corrected_at timestamptz,
  add column if not exists correction_reason text;

create or replace function public.domestic_sale_has_closed_billing(
  p_customer_code text,
  p_sale_date date
)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  is_closed boolean := false;
begin
  if p_sale_date is null or nullif(btrim(coalesce(p_customer_code,'')),'') is null then
    return false;
  end if;
  if to_regclass('public.domestic_billing_closings') is null then
    return false;
  end if;
  execute $query$
    select exists (
      select 1
      from public.domestic_billing_closings
      where customer_code = $1
        and status = 'closed'
        and $2 between period_from and period_to
    )
  $query$ into is_closed using p_customer_code, p_sale_date;
  return coalesce(is_closed,false);
end;
$$;

create or replace function public.correct_domestic_sale(
  p_sale_id uuid,
  p_sale_date date,
  p_customer_code text,
  p_shipping_amount_jpy numeric,
  p_memo text,
  p_lines jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_sale public.domestic_sales%rowtype;
  target_receivable public.domestic_receivables%rowtype;
  customer_row public.domestic_customer_master%rowtype;
  line_item jsonb;
  line_index integer := 0;
  line_product_code text;
  line_product_name text;
  line_unit text;
  line_quantity numeric(18,4);
  line_unit_price numeric(18,4);
  line_tax_rate smallint;
  line_net numeric(18,2);
  subtotal_8 numeric(18,2) := 0;
  subtotal_10 numeric(18,2) := 0;
  shipping_net numeric(18,2);
  tax_8 numeric(18,2);
  tax_10 numeric(18,2);
  total_net numeric(18,2);
  total_tax numeric(18,2);
  total_gross numeric(18,2);
  payment_due date;
begin
  if not public.is_master_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if p_sale_id is null then
    raise exception '修正する国内売上を選択してください。' using errcode = '22023';
  end if;
  if p_sale_date is null then
    raise exception '売上日を入力してください。' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason,''))) < 4 then
    raise exception '修正理由を4文字以上入力してください。' using errcode = '22023';
  end if;
  if coalesce(p_shipping_amount_jpy,0) < 0 then
    raise exception '送料は0以上で入力してください。' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception '商品明細を1件以上入力してください。' using errcode = '22023';
  end if;

  select * into target_sale
  from public.domestic_sales
  where id = p_sale_id
  for update;
  if not found then
    raise exception '修正する国内売上が見つかりません。' using errcode = 'P0002';
  end if;
  if target_sale.status <> 'confirmed' then
    raise exception '取消済みの国内売上は修正できません。' using errcode = '22023';
  end if;
  if coalesce(to_jsonb(target_sale) ->> 'source_type','manual') <> 'manual' then
    raise exception '輸出連動売上は輸出側の元データから修正してください。' using errcode = '22023';
  end if;

  select * into target_receivable
  from public.domestic_receivables
  where sale_id = p_sale_id
  for update;
  if not found then
    raise exception '対象の売掛が見つかりません。' using errcode = 'P0002';
  end if;
  if target_receivable.status = 'cancelled' then
    raise exception '取消済みの売掛は修正できません。' using errcode = '22023';
  end if;
  if target_receivable.paid_amount_jpy > 0 then
    raise exception '入金登録済みの売上は修正できません。先に入金を確認してください。' using errcode = '22023';
  end if;
  if public.domestic_sale_has_closed_billing(target_sale.customer_code,target_sale.sale_date) then
    raise exception '請求締め済みの売上は修正できません。先に国内売掛管理で締め解除してください。' using errcode = '22023';
  end if;

  select * into customer_row
  from public.domestic_customer_master
  where customer_code = btrim(coalesce(p_customer_code,''))
    and active
  for share;
  if not found then
    raise exception '有効な国内得意先が見つかりません。' using errcode = '22023';
  end if;
  if public.domestic_sale_has_closed_billing(customer_row.customer_code,p_sale_date) then
    raise exception '変更後の日付・得意先は請求締め済みです。先に国内売掛管理で締め解除してください。' using errcode = '22023';
  end if;

  shipping_net := round(coalesce(p_shipping_amount_jpy,0),2);
  perform set_config('app.audit_source','domestic-sale-correction',true);
  perform set_config('app.audit_reason',btrim(p_reason),true);

  delete from public.domestic_sale_lines where sale_id = p_sale_id;

  for line_item in select value from jsonb_array_elements(p_lines)
  loop
    line_index := line_index + 1;
    line_product_code := nullif(btrim(coalesce(line_item ->> 'product_code','')),'');
    line_product_name := nullif(btrim(coalesce(line_item ->> 'product_name','')),'');
    line_unit := coalesce(nullif(btrim(line_item ->> 'unit'),''),'Kg');
    line_quantity := coalesce(nullif(line_item ->> 'quantity','')::numeric,0);
    line_unit_price := coalesce(nullif(line_item ->> 'unit_price','')::numeric,0);
    line_tax_rate := coalesce(nullif(line_item ->> 'tax_rate','')::smallint,8);

    if line_product_code is not null then
      if not exists (select 1 from public.product_master where product_id = line_product_code) then
        raise exception '商品コード % は商品マスタにありません。', line_product_code using errcode = '23503';
      end if;
      if line_product_name is null then
        select nullif(btrim(product_name),'') into line_product_name
        from public.product_master where product_id = line_product_code;
      end if;
    end if;
    if line_product_name is null then
      raise exception '%行目の商品名を入力してください。', line_index using errcode = '22023';
    end if;
    if line_quantity <= 0 then
      raise exception '%行目の数量は0より大きい値を入力してください。', line_index using errcode = '22023';
    end if;
    if line_unit_price < 0 then
      raise exception '%行目の単価は0以上で入力してください。', line_index using errcode = '22023';
    end if;
    if line_unit not in ('Kg','pkt','PC','CS') then
      raise exception '%行目の単位が正しくありません。', line_index using errcode = '22023';
    end if;
    if line_tax_rate not in (8,10) then
      raise exception '%行目の税率は8%%または10%%です。', line_index using errcode = '22023';
    end if;

    line_net := round(line_quantity * line_unit_price,0);
    if line_tax_rate = 8 then subtotal_8 := subtotal_8 + line_net;
    else subtotal_10 := subtotal_10 + line_net;
    end if;

    insert into public.domestic_sale_lines (
      sale_id,line_no,product_code,product_name_snapshot,quantity,
      unit,unit_price_jpy,tax_rate,net_amount_jpy,memo
    ) values (
      p_sale_id,line_index,line_product_code,line_product_name,line_quantity,
      line_unit,line_unit_price,line_tax_rate,line_net,
      nullif(btrim(coalesce(line_item ->> 'memo','')),'')
    );
  end loop;

  tax_8 := floor(subtotal_8 * 0.08);
  tax_10 := floor((subtotal_10 + shipping_net) * 0.10);
  total_net := subtotal_8 + subtotal_10 + shipping_net;
  total_tax := tax_8 + tax_10;
  total_gross := total_net + total_tax;
  payment_due := public.domestic_receivable_due_date(
    p_sale_date,customer_row.closing_day,
    customer_row.payment_month_offset,customer_row.payment_day
  );

  update public.domestic_sales
  set sale_date = p_sale_date,
      customer_code = customer_row.customer_code,
      customer_name_snapshot = customer_row.customer_name,
      product_subtotal_8_jpy = subtotal_8,
      product_subtotal_10_jpy = subtotal_10,
      shipping_amount_jpy = shipping_net,
      total_net_jpy = total_net,
      tax_8_jpy = tax_8,
      tax_10_jpy = tax_10,
      tax_total_jpy = total_tax,
      total_amount_jpy = total_gross,
      memo = nullif(btrim(coalesce(p_memo,'')),''),
      corrected_by = auth.uid(),
      corrected_at = now(),
      correction_reason = btrim(p_reason)
  where id = p_sale_id;

  update public.domestic_receivables
  set customer_code = customer_row.customer_code,
      customer_name_snapshot = customer_row.customer_name,
      invoice_date = p_sale_date,
      due_date = payment_due,
      amount_jpy = total_gross,
      paid_amount_jpy = 0,
      balance_jpy = total_gross,
      status = case when total_gross = 0 then 'paid' else 'unpaid' end,
      memo = nullif(btrim(coalesce(p_memo,'')),'')
  where id = target_receivable.id;

  return jsonb_build_object(
    'id',p_sale_id,
    'sale_no',target_sale.sale_no,
    'total_net_jpy',total_net,
    'tax_total_jpy',total_tax,
    'total_amount_jpy',total_gross,
    'due_date',payment_due
  );
end;
$$;

create or replace function public.cancel_domestic_sale(
  p_sale_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_sale public.domestic_sales%rowtype;
  target_receivable public.domestic_receivables%rowtype;
begin
  if not public.is_master_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason,''))) < 3 then
    raise exception '取消理由を3文字以上入力してください。' using errcode = '22023';
  end if;

  select * into target_sale
  from public.domestic_sales
  where id = p_sale_id
  for update;
  if not found then
    raise exception '対象の国内売上が見つかりません。' using errcode = 'P0002';
  end if;
  if target_sale.status = 'cancelled' then return; end if;
  if coalesce(to_jsonb(target_sale) ->> 'source_type','manual') <> 'manual' then
    raise exception '輸出連動売上は輸出側の元データから修正してください。' using errcode = '22023';
  end if;
  if public.domestic_sale_has_closed_billing(target_sale.customer_code,target_sale.sale_date) then
    raise exception '請求締め済みの売上は取消できません。先に国内売掛管理で締め解除してください。' using errcode = '22023';
  end if;

  select * into target_receivable
  from public.domestic_receivables
  where sale_id = p_sale_id
  for update;
  if not found then
    raise exception '対象の売掛が見つかりません。' using errcode = 'P0002';
  end if;
  if target_receivable.paid_amount_jpy > 0 then
    raise exception '入金済みの売上は取消できません。先に入金を確認してください。' using errcode = '22023';
  end if;

  perform set_config('app.audit_source','domestic-sale-cancel',true);
  perform set_config('app.audit_reason',btrim(p_reason),true);

  update public.domestic_sales
  set status = 'cancelled',cancelled_by = auth.uid(),cancelled_at = now(),
      cancellation_reason = btrim(p_reason)
  where id = p_sale_id and status = 'confirmed';

  update public.domestic_receivables
  set status = 'cancelled',balance_jpy = 0,
      memo = concat_ws(' / ',memo,'売上取消: ' || btrim(p_reason)),
      updated_by = auth.uid()
  where id = target_receivable.id;
end;
$$;

revoke all on function public.domestic_sale_has_closed_billing(text,date) from public,anon,authenticated;
revoke all on function public.correct_domestic_sale(uuid,date,text,numeric,text,jsonb,text) from public,anon;
revoke all on function public.cancel_domestic_sale(uuid,text) from public,anon;
grant execute on function public.correct_domestic_sale(uuid,date,text,numeric,text,jsonb,text) to authenticated;
grant execute on function public.cancel_domestic_sale(uuid,text) to authenticated;

commit;
