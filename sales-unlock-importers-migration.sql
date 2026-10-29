-- Scoped administrative reopening. Installation does not change financial records.
begin;

alter table public.work_sessions add column if not exists reopened_importer_codes text[] not null default '{}'::text[];

create or replace function public.guard_importer_finalization_state()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if current_setting('app.importer_finalization_session',true)=new.id::text then return new; end if;
  if old.locked and not new.locked and public.is_master_admin() then
    -- Compatibility for older clients that reopen the entire work session.
    select coalesce(array_agg(distinct c order by c),'{}'::text[]) into new.reopened_importer_codes
    from (select public.canonical_importer_code(x) c from unnest(old.finalized_importer_codes) x
      union select public.canonical_importer_code(coalesce(importer_code,importer_id,'')) from public.sales_records where session_id=old.id) codes;
    new.finalized_importer_codes:='{}';
    return new;
  end if;
  if new.finalized_importer_codes is distinct from old.finalized_importer_codes
    or new.reopened_importer_codes is distinct from old.reopened_importer_codes then
    raise exception '輸入社の確定状態は売上確定・解除処理から更新してください。';
  end if;
  if cardinality(old.finalized_importer_codes||old.reopened_importer_codes)>0
    and (new.work_date is distinct from old.work_date or new.site_code is distinct from old.site_code
      or new.locked is distinct from old.locked or new.status is distinct from old.status or new.finalized_at is distinct from old.finalized_at) then
    raise exception '輸入社別の売上確定・解除を使用してください。拠点・作業日は変更できません。';
  end if;
  return new;
end;
$$;

create or replace function public.unlock_work_session_importers(
  p_session_id uuid,p_importer_codes text[],p_reason text,p_expected_version text
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  w public.work_sessions; preview jsonb; codes text[]; code text; completed text[]; reopened text[]; previous_context text;
  ds public.domestic_sales; dr public.domestic_receivables;
begin
  if not public.is_internal_user() or not public.is_master_admin() then raise exception '売上確定の解除は管理者のみ可能です。' using errcode='42501'; end if;
  if length(btrim(coalesce(p_reason,'')))<4 then raise exception '解除理由を4文字以上で入力してください。'; end if;
  select * into w from public.work_sessions where id=p_session_id for update;
  if not found then raise exception '対象作業が見つかりません。'; end if;
  if w.status='archived' or w.provisional_locked then raise exception 'アーカイブ・仮締め状態を確認してください。'; end if;
  perform 1 from public.order_lines where session_id=p_session_id for update;
  perform 1 from public.boxes where session_id=p_session_id for update;
  perform 1 from public.sales_records where session_id=p_session_id for update;
  perform 1 from public.accounts_receivable where source_session_id=p_session_id for update;
  select array_agg(distinct public.canonical_importer_code(x) order by public.canonical_importer_code(x)) into codes
    from unnest(p_importer_codes) x where nullif(btrim(x),'') is not null;
  if coalesce(cardinality(codes),0)=0 then raise exception '解除する輸入社を選択してください。'; end if;
  preview:=public.work_importer_finalization_preview(p_session_id);
  if p_expected_version is null or p_expected_version<>preview->>'version' then
    raise exception '確認中に作業または売上が変更されました。解除画面を開き直してください。' using errcode='40001';
  end if;
  foreach code in array codes loop
    if not exists(select 1 from jsonb_array_elements(preview->'groups') g where g->>'importer_code'=code and (g->>'finalized')::boolean)
      or code=any(w.reopened_importer_codes) then raise exception '輸入社 % は確定済みではありません。',code; end if;
    if not exists(select 1 from public.sales_records r where session_id=p_session_id and public.canonical_importer_code(coalesce(importer_code,importer_id,''))=code) then
      raise exception '輸入社 % の確定売上が見つかりません。管理者が確認してください。',code;
    end if;
    if exists(select 1 from public.accounts_receivable r where r.source_session_id=p_session_id
      and public.canonical_importer_code(r.importer_code)=code
      and (r.closing_id is not null or exists(select 1 from public.accounts_receivable_payments p where p.receivable_id=r.id))) then
      raise exception '輸入社 % は請求締め済みまたは入金登録済みです。先に売掛管理で確認してください。',code;
    end if;
    if (select count(*) from public.domestic_sales where source_session_id=p_session_id and public.canonical_importer_code(source_importer_code)=code)>1 then
      raise exception '輸入社 % の国内売上が複数あります。管理者が確認してください。',code;
    end if;
    select * into ds from public.domestic_sales where source_session_id=p_session_id and public.canonical_importer_code(source_importer_code)=code for update;
    if found then
      select * into dr from public.domestic_receivables where sale_id=ds.id for update;
      if ds.status<>'confirmed' or dr.id is null or dr.status='cancelled' or dr.paid_amount_jpy>0
        or exists(select 1 from public.domestic_receivable_payments p where p.receivable_id=dr.id)
        or public.domestic_sale_has_closed_billing(ds.customer_code,ds.sale_date) then
        raise exception '輸入社 % の国内売上は取消・請求締め・入金状態を確認してください。',code;
      end if;
    elsif exists(select 1 from public.sales_records r where session_id=p_session_id
      and public.canonical_importer_code(coalesce(importer_code,importer_id,''))=code and revenue_recognition_mode='customs_only') then
      raise exception '輸入社 % の国内連動売上が見つかりません。',code;
    end if;
  end loop;
  select coalesce(array_agg(distinct g->>'importer_code' order by g->>'importer_code'),'{}'::text[]) into completed
    from jsonb_array_elements(preview->'groups') g where (g->>'finalized')::boolean and not(g->>'importer_code'=any(codes));
  select array_agg(distinct c order by c) into reopened from unnest(w.reopened_importer_codes||codes) c;
  previous_context:=current_setting('app.importer_finalization_session',true);
  perform set_config('app.importer_finalization_session',p_session_id::text,true);
  perform set_config('app.audit_source','importer-sales-unlock',true);
  perform set_config('app.audit_reason',btrim(p_reason),true);
  update public.work_sessions set locked=false,status='active',finalized_importer_codes=completed,reopened_importer_codes=reopened,
    unlocked_at=now(),unlocked_by=auth.uid(),unlock_reason=btrim(p_reason) where id=p_session_id returning * into w;
  foreach code in array codes loop
    insert into public.sales_correction_log(action_type,session_id,importer_code,old_values,new_values,reason,changed_by)
    values('sales_record',p_session_id,code,jsonb_build_object('finalized',true),jsonb_build_object('finalized',false,'reopened',true),btrim(p_reason),auth.uid());
  end loop;
  perform set_config('app.importer_finalization_session',coalesce(previous_context,''),true);
  return jsonb_build_object('session',to_jsonb(w),'importer_codes',codes);
end;
$$;

create or replace function public.work_reopened_importer_preview(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare w public.work_sessions; preview jsonb; groups jsonb; version text;
begin
  if not public.is_internal_user() or not public.is_master_admin() then raise exception '再確定は管理者のみ可能です。' using errcode='42501'; end if;
  select * into w from public.work_sessions where id=p_session_id;
  if not found or cardinality(w.reopened_importer_codes)=0 then raise exception '解除した輸入社がありません。'; end if;
  preview:=public.work_importer_finalization_preview(p_session_id);
  select coalesce(jsonb_agg(g||jsonb_build_object(
    'changed',g->>'importer_code'=any(w.reopened_importer_codes),
    'reopened',g->>'importer_code'=any(w.reopened_importer_codes),
    'domestic',(select jsonb_build_object('id',d.id,'status',d.status) from public.domestic_sales d
      where d.source_session_id=p_session_id and public.canonical_importer_code(d.source_importer_code)=g->>'importer_code' limit 1),
    'receivable_count',(select count(*) from public.accounts_receivable r where r.source_session_id=p_session_id
      and r.source_type='sales' and public.canonical_importer_code(r.importer_code)=g->>'importer_code')
  ) order by g->>'importer_code'),'[]'::jsonb) into groups from jsonb_array_elements(preview->'groups') g;
  select md5(jsonb_build_object('preview',preview,
    'receivables',(select jsonb_agg(to_jsonb(r) order by r.id) from public.accounts_receivable r where source_session_id=p_session_id),
    'domestic',(select jsonb_agg(to_jsonb(d) order by d.id) from public.domestic_sales d where source_session_id=p_session_id))::text) into version;
  return jsonb_build_object('session',to_jsonb(w),'version',version,'groups',groups);
end;
$$;

create or replace function public.refinalize_work_session_importers(
  p_session_id uuid,p_importer_codes text[],p_shipping_fees jsonb,p_expected_version text
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  w public.work_sessions; before_state jsonb; after_state jsonb; codes text[]; code text;
  source_item record; s public.sales_records; previous_sales jsonb; group_state jsonb;
  fee numeric; fees jsonb; net numeric; customer_names jsonb; customer_label text; importer_label text;
  receivable public.accounts_receivable; ds public.domestic_sales; dr public.domestic_receivables;
  dl public.domestic_sale_lines; subtotal8 numeric; subtotal10 numeric; tax8 numeric; tax10 numeric; total numeric;
  pending text[]; saved integer:=0; next_line integer; operation_start date;
  scoped boolean; completed text[]; reopened text[]; previous_context text;
begin
  if not public.is_internal_user() or not public.is_master_admin() then
    raise exception '再確定は管理者のみ可能です。' using errcode='42501';
  end if;
  select * into w from public.work_sessions where id=p_session_id for update;
  if not found then raise exception '対象作業が見つかりません。'; end if;
  if w.locked or w.status='closed' then raise exception 'すでに確定済みです。最新状態を読み込んでください。'; end if;
  scoped:=cardinality(w.reopened_importer_codes)>0;
  if (w.finalized_at is null and not scoped) or w.work_date is null then raise exception '再確定する作業日・確定履歴を確認してください。'; end if;
  perform 1 from public.order_lines where session_id=p_session_id for update;
  perform 1 from public.boxes where session_id=p_session_id for update;
  perform 1 from public.sales_records where session_id=p_session_id for update;
  perform 1 from public.accounts_receivable where source_session_id=p_session_id for update;
  select array_agg(distinct public.canonical_importer_code(x)) into codes from unnest(p_importer_codes) x where nullif(btrim(x),'') is not null;
  if coalesce(cardinality(codes),0)=0 then raise exception '再確定する輸入社を選択してください。'; end if;
  if scoped and exists(select 1 from unnest(codes) c where not(c=any(w.reopened_importer_codes))) then
    raise exception '再確定できるのは解除した輸入社のみです。';
  end if;
  before_state:=case when scoped then public.work_reopened_importer_preview(p_session_id) else public.work_refinalization_preview(p_session_id) end;
  if p_expected_version is null or p_expected_version<>before_state->>'version' then
    raise exception '確認中に作業または売上が変更されました。再読み込みして確認してください。' using errcode='40001';
  end if;
  if jsonb_typeof(p_shipping_fees) is distinct from 'object' then raise exception '送料の形式を確認してください。'; end if;
  if exists(select 1 from jsonb_object_keys(p_shipping_fees) k where not(k=any(codes))) then raise exception '選択していない輸入社の送料は変更できません。'; end if;
  if exists(select 1 from public.sales_records old join public.work_refinalization_source(p_session_id) x on x.source_row_no=old.source_row_no where old.session_id=p_session_id and public.canonical_importer_code(coalesce(old.importer_code,old.importer_id,''))<>x.importer_code and ((public.canonical_importer_code(coalesce(old.importer_code,old.importer_id,''))=any(codes)) or x.importer_code=any(codes))) then
    raise exception '輸入社の付け替えは売上参照の管理者修正を使用してください。';
  end if;
  if exists(select 1 from public.sales_records old where old.session_id=p_session_id and public.canonical_importer_code(coalesce(old.importer_code,old.importer_id,''))=any(codes) and not exists(select 1 from public.order_lines l where l.session_id=old.session_id and l.source_row_no=old.source_row_no)) then
    raise exception '元の作業明細が削除されています。売上を一括削除せず、管理者が明細を確認してください。';
  end if;
  fees:=coalesce(w.shipping_fees,'{}'::jsonb);
  select coalesce(operation_start_date,date '2026-08-01') into operation_start from public.accounts_receivable_settings where singleton=true;
  operation_start:=coalesce(operation_start,date '2026-08-01');
  previous_context:=current_setting('app.importer_finalization_session',true);
  perform set_config('app.importer_finalization_session',p_session_id::text,true);
  perform set_config('app.audit_source','importer-sales-refinalization',true);
  perform set_config('app.audit_reason',coalesce(nullif(w.unlock_reason,''),'輸入社別再確定'),true);
  foreach code in array codes loop
    select value into group_state from jsonb_array_elements(before_state->'groups') where value->>'importer_code'=code;
    if group_state is null or (group_state->>'line_count')::integer=0 then raise exception '輸入社 % の作業明細がありません。',code; end if;
    fee:=coalesce((p_shipping_fees->>code)::numeric,(group_state->>'shipping')::numeric,0);
    if fee<0 or fee<>round(fee,0) then raise exception '送料は0以上の整数で入力してください。'; end if;
    importer_label:=group_state->>'importer_name';
    select jsonb_agg(to_jsonb(x) order by x.source_row_no) into previous_sales from public.sales_records x where x.session_id=p_session_id and public.canonical_importer_code(coalesce(x.importer_code,x.importer_id,''))=code;
    if exists(select 1 from public.accounts_receivable r where r.source_session_id=p_session_id and public.canonical_importer_code(r.importer_code)=code and (r.closing_id is not null or exists(select 1 from public.accounts_receivable_payments p where p.receivable_id=r.id))) then
      raise exception '輸入社 % は請求締め済みまたは入金登録済みです。先に売掛管理で確認してください。',code;
    end if;
    if (select count(*) from public.domestic_sales where source_session_id=p_session_id and public.canonical_importer_code(source_importer_code)=code)>1 then raise exception '輸入社 % の国内売上が複数あります。重複の照合が必要です。',code; end if;
    select * into ds from public.domestic_sales where source_session_id=p_session_id and public.canonical_importer_code(source_importer_code)=code for update;
    if found then
      select * into dr from public.domestic_receivables where sale_id=ds.id for update;
      if ds.status<>'confirmed' or dr.id is null or dr.status='cancelled' or dr.paid_amount_jpy>0 or exists(select 1 from public.domestic_receivable_payments p where p.receivable_id=dr.id) or public.domestic_sale_has_closed_billing(ds.customer_code,ds.sale_date) then
        raise exception '輸入社 % の国内売上は取消・請求締め・入金状態を確認してください。',code;
      end if;
    elsif exists(select 1 from public.sales_records x where x.session_id=p_session_id and public.canonical_importer_code(coalesce(x.importer_code,x.importer_id,''))=code and x.revenue_recognition_mode='customs_only') then
      raise exception '輸入社 % の国内連動売上が見つかりません。管理者確認が必要です。',code;
    end if;
    for source_item in select * from public.work_refinalization_source(p_session_id) where importer_code=code order by source_row_no loop
      s:=jsonb_populate_record(null::public.sales_records,source_item.payload);
      insert into public.sales_records(session_id,source_row_no,work_date,finalized_at,finalized_by,country_code,importer_id,importer_code,store_name,product_id,product_name,english_name,scientific_name,origin,ordered_qty,ordered_unit,input_qty,input_unit,net_weight,box_no,gross_weight,dry_ice_enabled,dry_ice_weight,box_size,unit_price,amount,memo,is_stockout,site_code,revenue_recognition_mode,domestic_sale_id)
      values(s.session_id,s.source_row_no,s.work_date,now(),auth.uid(),s.country_code,s.importer_id,s.importer_code,s.store_name,s.product_id,s.product_name,s.english_name,s.scientific_name,s.origin,s.ordered_qty,s.ordered_unit,s.input_qty,s.input_unit,s.net_weight,s.box_no,s.gross_weight,s.dry_ice_enabled,s.dry_ice_weight,s.box_size,s.unit_price,s.amount,s.memo,s.is_stockout,s.site_code,case when ds.id is null then 'direct_export' else 'customs_only' end,ds.id)
      on conflict(session_id,source_row_no) do update set
        work_date=excluded.work_date,finalized_at=excluded.finalized_at,finalized_by=excluded.finalized_by,country_code=excluded.country_code,importer_id=excluded.importer_id,importer_code=excluded.importer_code,store_name=excluded.store_name,product_id=excluded.product_id,product_name=excluded.product_name,english_name=excluded.english_name,scientific_name=excluded.scientific_name,origin=excluded.origin,ordered_qty=excluded.ordered_qty,ordered_unit=excluded.ordered_unit,input_qty=excluded.input_qty,input_unit=excluded.input_unit,net_weight=excluded.net_weight,box_no=excluded.box_no,gross_weight=excluded.gross_weight,dry_ice_enabled=excluded.dry_ice_enabled,dry_ice_weight=excluded.dry_ice_weight,box_size=excluded.box_size,unit_price=excluded.unit_price,amount=excluded.amount,memo=excluded.memo,is_stockout=excluded.is_stockout,site_code=excluded.site_code,revenue_recognition_mode=excluded.revenue_recognition_mode,domestic_sale_id=excluded.domestic_sale_id;
      saved:=saved+1;
    end loop;
    select coalesce(sum(amount) filter(where not is_stockout),0),coalesce(jsonb_agg(distinct store_name) filter(where not is_stockout and nullif(btrim(store_name),'') is not null),'[]'::jsonb) into net,customer_names from public.sales_records x where session_id=p_session_id and public.canonical_importer_code(coalesce(x.importer_code,x.importer_id,''))=code;
    customer_label:=case when jsonb_array_length(customer_names)>1 then (customer_names->>0)||' 他'||(jsonb_array_length(customer_names)-1)||'件' else coalesce(customer_names->>0,'') end;
    if ds.id is null then
      if (group_state->>'receivable_count')::integer>1 then raise exception '輸入社 % の請求候補が複数あります。重複の照合が必要です。',code; end if;
      select * into receivable from public.accounts_receivable r where r.source_session_id=p_session_id and r.source_type='sales' and public.canonical_importer_code(r.importer_code)=code for update;
      if (w.work_date>=operation_start or receivable.id is not null) and (net+fee<>0 or receivable.id is not null) then
        insert into public.accounts_receivable(source_key,source_type,source_session_id,importer_code,importer_name,customer_name,customer_names,invoice_no,invoice_date,currency,net_sales_jpy,shipping_amount_jpy,amount_jpy,created_by,updated_by)
        values(coalesce(receivable.source_key,'sales:'||p_session_id::text||':'||code),'sales',p_session_id,code,importer_label,customer_label,customer_names,coalesce(receivable.invoice_no,case when code~'^[0-9]{1,3}$' then to_char(w.work_date,'YYYYMMDD')||lpad(code,3,'0') end),w.work_date,'JPY',net,fee,net+fee,auth.uid(),auth.uid())
        on conflict(source_key) do update set importer_code=excluded.importer_code,importer_name=excluded.importer_name,customer_name=excluded.customer_name,customer_names=excluded.customer_names,invoice_date=excluded.invoice_date,net_sales_jpy=excluded.net_sales_jpy,shipping_amount_jpy=excluded.shipping_amount_jpy,amount_jpy=excluded.amount_jpy,updated_by=excluded.updated_by;
      end if;
    else
      for s in select * from public.sales_records x where session_id=p_session_id and public.canonical_importer_code(coalesce(x.importer_code,x.importer_id,''))=code order by source_row_no loop
        select * into dl from public.domestic_sale_lines where sale_id=ds.id and source_sales_record_id=s.id;
        if s.is_stockout or coalesce(s.input_qty,0)<=0 then
          if dl.id is not null then delete from public.domestic_sale_lines where id=dl.id; end if;
          continue;
        end if;
        if coalesce(s.unit_price,0)<0 then raise exception '国内連動売上の単価は0以上で入力してください。'; end if;
        select coalesce(max(line_no),0)+1 into next_line from public.domestic_sale_lines where sale_id=ds.id;
        insert into public.domestic_sale_lines(sale_id,line_no,product_code,product_name_snapshot,quantity,unit,unit_price_jpy,tax_rate,net_amount_jpy,memo,source_sales_record_id)
        values(ds.id,coalesce(dl.line_no,next_line),case when exists(select 1 from public.product_master p where p.product_id=s.product_id) then s.product_id end,coalesce(s.product_name,s.product_id,'未登録商品'),s.input_qty,case upper(coalesce(s.input_unit,'KG')) when 'PKT' then 'pkt' when 'PC' then 'PC' when 'CS' then 'CS' else 'Kg' end,coalesce(s.unit_price,0),coalesce(dl.tax_rate,8),coalesce(s.amount,0),concat_ws(' / ',s.memo,'輸出先: '||s.store_name),s.id)
        on conflict(sale_id,line_no) do update set product_code=excluded.product_code,product_name_snapshot=excluded.product_name_snapshot,quantity=excluded.quantity,unit=excluded.unit,unit_price_jpy=excluded.unit_price_jpy,net_amount_jpy=excluded.net_amount_jpy,memo=excluded.memo;
      end loop;
      select coalesce(sum(net_amount_jpy) filter(where tax_rate=8),0),coalesce(sum(net_amount_jpy) filter(where tax_rate=10),0) into subtotal8,subtotal10 from public.domestic_sale_lines where sale_id=ds.id;
      tax8:=floor(subtotal8*.08);tax10:=floor((subtotal10+fee)*.10);total:=subtotal8+subtotal10+fee+tax8+tax10;
      update public.domestic_sales set product_subtotal_8_jpy=subtotal8,product_subtotal_10_jpy=subtotal10,shipping_amount_jpy=fee,total_net_jpy=subtotal8+subtotal10+fee,tax_8_jpy=tax8,tax_10_jpy=tax10,tax_total_jpy=tax8+tax10,total_amount_jpy=total,corrected_at=now(),corrected_by=auth.uid(),correction_reason=coalesce(w.unlock_reason,'輸出作業の再確定') where id=ds.id;
      update public.domestic_receivables set amount_jpy=total,balance_jpy=total,status=case when total=0 then 'paid' else 'unpaid' end,updated_by=auth.uid() where id=dr.id;
    end if;
    select coalesce(jsonb_object_agg(k,v),'{}'::jsonb) into fees from jsonb_each(fees) e(k,v) where public.canonical_importer_code(k)<>code;
    fees:=fees||jsonb_build_object(code,fee);
    insert into public.sales_correction_log(action_type,session_id,importer_code,old_values,new_values,reason,changed_by)
    values('sales_record',p_session_id,code,jsonb_build_object('sales_records',previous_sales,'summary',group_state),jsonb_build_object('net_sales',net,'shipping',fee,'line_count',group_state->'line_count'),'輸入社別再確定: '||coalesce(w.unlock_reason,'訂正'),auth.uid());
  end loop;
  update public.work_sessions set shipping_fees=fees,shipping_fee=(select coalesce(sum((v#>>'{}')::numeric),0) from jsonb_each(fees) e(k,v)) where id=p_session_id;
  if scoped then
    select coalesce(array_agg(distinct c order by c),'{}'::text[]) into completed from unnest(w.finalized_importer_codes||codes) c;
    select coalesce(array_agg(c order by c),'{}'::text[]) into reopened from unnest(w.reopened_importer_codes) c where not(c=any(codes));
    select coalesce(array_agg(distinct importer_code order by importer_code),'{}'::text[]) into pending
      from public.work_refinalization_source(p_session_id) where not(importer_code=any(completed));
    update public.work_sessions set finalized_importer_codes=completed,reopened_importer_codes=reopened,
      locked=cardinality(pending||reopened)=0,status=case when cardinality(pending||reopened)=0 then 'closed' else 'active' end,
      finalized_at=case when cardinality(pending||reopened)=0 then now() else finalized_at end,
      finalized_by=case when cardinality(pending||reopened)=0 then auth.uid() else finalized_by end where id=p_session_id returning * into w;
  else
    after_state:=public.work_refinalization_preview(p_session_id);
    select coalesce(array_agg(g->>'importer_code'),'{}'::text[]) into pending from jsonb_array_elements(after_state->'groups') g where (g->>'changed')::boolean;
    update public.work_sessions set locked=cardinality(pending)=0,status=case when cardinality(pending)=0 then 'closed' else 'active' end,
      finalized_at=case when cardinality(pending)=0 then now() else finalized_at end,finalized_by=case when cardinality(pending)=0 then auth.uid() else finalized_by end where id=p_session_id returning * into w;
  end if;
  perform set_config('app.importer_finalization_session',coalesce(previous_context,''),true);
  return jsonb_build_object('session',to_jsonb(w),'saved_rows',saved,'importer_codes',codes,'pending_importers',pending);
end;
$$;

revoke all on function public.unlock_work_session_importers(uuid,text[],text,text) from public,anon;
revoke all on function public.work_reopened_importer_preview(uuid) from public,anon;
revoke all on function public.refinalize_work_session_importers(uuid,text[],jsonb,text) from public,anon;
revoke all on function public.guard_importer_finalization_state() from public,anon,authenticated;
grant execute on function public.unlock_work_session_importers(uuid,text[],text,text) to authenticated;
grant execute on function public.work_reopened_importer_preview(uuid) to authenticated;
grant execute on function public.refinalize_work_session_importers(uuid,text[],jsonb,text) to authenticated;
notify pgrst,'reload schema';
commit;
