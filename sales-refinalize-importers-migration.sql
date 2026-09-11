-- Importer-scoped re-finalization. Installation changes functions only, not business data.
begin;

create or replace function public.work_refinalization_source(p_session_id uuid)
returns table(source_row_no integer, importer_code text, payload jsonb)
language sql stable security definer set search_path=public,pg_temp as $$
  select l.source_row_no,public.canonical_importer_code(coalesce(l.importer_code,l.importer_id,'')),
    jsonb_build_object(
      'session_id',l.session_id,'source_row_no',l.source_row_no,'work_date',w.work_date,
      'country_code',l.country_code,'importer_id',l.importer_id,'importer_code',l.importer_code,
      'store_name',l.store_name,'product_id',l.product_id,'product_name',l.product_name,
      'english_name',l.english_name,'scientific_name',l.scientific_name,'origin',l.origin,
      'ordered_qty',l.ordered_qty,'ordered_unit',l.ordered_unit,'input_qty',l.input_qty,'input_unit',l.input_unit,
      'net_weight',l.net_weight,'box_no',l.box_no,'gross_weight',b.gross_weight,
      'dry_ice_enabled',coalesce(b.dry_ice_enabled,false),'dry_ice_weight',b.dry_ice_weight,'box_size',b.box_size,
      'unit_price',l.unit_price,'amount',case when l.is_stockout then null else round(l.input_qty*l.unit_price,0) end,
      'memo',l.memo,'is_stockout',l.is_stockout,'site_code',w.site_code
    )
  from public.order_lines l join public.work_sessions w on w.id=l.session_id
  left join lateral (
    select b.* from public.boxes b where b.session_id=l.session_id and b.box_no=l.box_no
      and public.canonical_importer_code(b.importer_code)=public.canonical_importer_code(coalesce(l.importer_code,l.importer_id,''))
    order by case when b.importer_code=l.importer_code then 0 else 1 end,b.id limit 1
  ) b on true
  where l.session_id=p_session_id;
$$;

create or replace function public.work_refinalization_preview(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare w public.work_sessions; result jsonb; version text; operation_start date;
begin
  if not public.is_internal_user() or not public.is_master_admin() then
    raise exception '再確定は管理者のみ可能です。' using errcode='42501';
  end if;
  select * into w from public.work_sessions where id=p_session_id;
  if not found then raise exception '対象作業が見つかりません。'; end if;
  if w.finalized_at is null then raise exception '初回の売上確定を使用してください。'; end if;
  select coalesce(operation_start_date,date '2026-08-01') into operation_start from public.accounts_receivable_settings where singleton=true;
  operation_start:=coalesce(operation_start,date '2026-08-01');
  select md5(jsonb_build_object(
    'session',to_jsonb(w),
    'work',(select jsonb_agg(x.payload order by x.source_row_no) from public.work_refinalization_source(p_session_id) x),
    'sales',(select jsonb_agg(to_jsonb(s) order by s.source_row_no) from public.sales_records s where s.session_id=p_session_id),
    'receivables',(select jsonb_agg(to_jsonb(r) order by r.id) from public.accounts_receivable r where r.source_session_id=p_session_id),
    'domestic',(select jsonb_agg(to_jsonb(d) order by d.id) from public.domestic_sales d where d.source_session_id=p_session_id)
  )::text) into version;
  with source as materialized (select * from public.work_refinalization_source(p_session_id)),
  codes as (
    select importer_code from source union select public.canonical_importer_code(coalesce(importer_code,importer_id,'')) from public.sales_records where session_id=p_session_id
  ), groups as (
    select c.importer_code,
      coalesce((select m.importer_name from public.importer_master m where public.canonical_importer_code(m.importer_code)=c.importer_code order by (m.importer_code=c.importer_code) desc,m.importer_code limit 1),c.importer_code) as importer_name,
      (select count(*) from source s where s.importer_code=c.importer_code) as line_count,
      (select count(*) from source s where s.importer_code=c.importer_code and not coalesce((s.payload->>'is_stockout')::boolean,false) and (coalesce((s.payload->>'input_qty')::numeric,0)=0 or coalesce((s.payload->>'net_weight')::numeric,0)=0 or coalesce(s.payload->>'box_no','')='')) as incomplete,
      coalesce((select sum((s.payload->>'amount')::numeric) from source s where s.importer_code=c.importer_code),0) as net_sales,
      coalesce((select (f.value#>>'{}')::numeric from jsonb_each(w.shipping_fees) f where public.canonical_importer_code(f.key)=c.importer_code order by (f.key=c.importer_code) desc,f.key limit 1),case when (select count(*) from codes)=1 then w.shipping_fee else 0 end,0) as shipping,
      exists(select 1 from source x left join public.sales_records s on s.session_id=p_session_id and s.source_row_no=x.source_row_no where x.importer_code=c.importer_code and (s.id is null or x.payload is distinct from (select jsonb_object_agg(k,to_jsonb(s)->k) from jsonb_object_keys(x.payload) k)))
      or exists(select 1 from public.sales_records s where s.session_id=p_session_id and public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,''))=c.importer_code and not exists(select 1 from source x where x.source_row_no=s.source_row_no and x.importer_code=c.importer_code)) as detail_changed,
      (select jsonb_build_object('id',d.id,'product_net',d.total_net_jpy-d.shipping_amount_jpy,'shipping',d.shipping_amount_jpy,'status',d.status) from public.domestic_sales d where d.source_session_id=p_session_id and public.canonical_importer_code(d.source_importer_code)=c.importer_code limit 1) as domestic,
      (select count(*) from public.accounts_receivable r where r.source_session_id=p_session_id and r.source_type='sales' and public.canonical_importer_code(r.importer_code)=c.importer_code) as receivable_count,
      (select coalesce(sum(r.net_sales_jpy),0) from public.accounts_receivable r where r.source_session_id=p_session_id and r.source_type='sales' and public.canonical_importer_code(r.importer_code)=c.importer_code) as receivable_net,
      (select coalesce(sum(r.shipping_amount_jpy),0) from public.accounts_receivable r where r.source_session_id=p_session_id and r.source_type='sales' and public.canonical_importer_code(r.importer_code)=c.importer_code) as receivable_shipping
    from codes c
  ) select coalesce(jsonb_agg(to_jsonb(g)||jsonb_build_object('changed',g.detail_changed or case when g.domestic is not null then (g.domestic->>'product_net')::numeric<>g.net_sales or (g.domestic->>'shipping')::numeric<>g.shipping when w.work_date<operation_start and g.receivable_count=0 then false else g.receivable_net<>g.net_sales or g.receivable_shipping<>g.shipping or (g.net_sales+g.shipping<>0 and g.receivable_count<>1) end) order by g.importer_code),'[]'::jsonb) into result from groups g;
  return jsonb_build_object('session',to_jsonb(w),'version',version,'groups',result);
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
begin
  if not public.is_internal_user() or not public.is_master_admin() then
    raise exception '再確定は管理者のみ可能です。' using errcode='42501';
  end if;
  select * into w from public.work_sessions where id=p_session_id for update;
  if not found then raise exception '対象作業が見つかりません。'; end if;
  if w.locked or w.status='closed' then raise exception 'すでに確定済みです。最新状態を読み込んでください。'; end if;
  if w.finalized_at is null or w.work_date is null then raise exception '再確定する作業日・確定履歴を確認してください。'; end if;
  perform 1 from public.order_lines where session_id=p_session_id for update;
  perform 1 from public.boxes where session_id=p_session_id for update;
  perform 1 from public.sales_records where session_id=p_session_id for update;
  perform 1 from public.accounts_receivable where source_session_id=p_session_id for update;
  select array_agg(distinct public.canonical_importer_code(x)) into codes from unnest(p_importer_codes) x where nullif(btrim(x),'') is not null;
  if coalesce(cardinality(codes),0)=0 then raise exception '再確定する輸入社を選択してください。'; end if;
  before_state:=public.work_refinalization_preview(p_session_id);
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
      if w.work_date>=operation_start or receivable.id is not null then
        insert into public.accounts_receivable(source_key,source_type,source_session_id,importer_code,importer_name,customer_name,customer_names,invoice_no,invoice_date,currency,net_sales_jpy,shipping_amount_jpy,amount_jpy,created_by,updated_by)
        values(coalesce(receivable.source_key,'sales:'||p_session_id::text||':'||code),'sales',p_session_id,code,importer_label,customer_label,customer_names,coalesce(receivable.invoice_no,case when code~'^[0-9]{1,3}$' then to_char(w.work_date,'YYYYMMDD')||lpad(code,3,'0') end),w.work_date,'JPY',net,fee,net+fee,auth.uid(),auth.uid())
        on conflict(source_key) do update set importer_code=excluded.importer_code,importer_name=excluded.importer_name,customer_name=excluded.customer_name,customer_names=excluded.customer_names,invoice_date=excluded.invoice_date,net_sales_jpy=excluded.net_sales_jpy,shipping_amount_jpy=excluded.shipping_amount_jpy,amount_jpy=excluded.amount_jpy,updated_by=excluded.updated_by;
      end if;
    else
      -- Reuse the domestic sale/receivable IDs. Never create a second linked invoice.
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
  after_state:=public.work_refinalization_preview(p_session_id);
  select coalesce(array_agg(g->>'importer_code'),'{}'::text[]) into pending from jsonb_array_elements(after_state->'groups') g where (g->>'changed')::boolean;
  update public.work_sessions set locked=cardinality(pending)=0,status=case when cardinality(pending)=0 then 'closed' else 'active' end,finalized_at=case when cardinality(pending)=0 then now() else finalized_at end,finalized_by=case when cardinality(pending)=0 then auth.uid() else finalized_by end where id=p_session_id returning * into w;
  return jsonb_build_object('session',to_jsonb(w),'saved_rows',saved,'importer_codes',codes,'pending_importers',pending);
end;
$$;

revoke all on function public.work_refinalization_source(uuid) from public,anon,authenticated;
revoke all on function public.work_refinalization_preview(uuid) from public,anon;
revoke all on function public.refinalize_work_session_importers(uuid,text[],jsonb,text) from public,anon;
grant execute on function public.work_refinalization_preview(uuid) to authenticated;
grant execute on function public.refinalize_work_session_importers(uuid,text[],jsonb,text) to authenticated;
notify pgrst,'reload schema';
commit;
