-- Initial importer-scoped finalization. Existing transactions are not backfilled.
begin;
-- Apply work-additional-order-migration.sql as well to allow additions to still-open importers.

alter table public.work_sessions add column if not exists finalized_importer_codes text[] not null default '{}'::text[];

create or replace function public.finalize_export_revenue_route_scoped(
  p_session_id uuid,
  p_work_date date,
  p_finalized_at timestamptz,
  p_shipping_fee numeric,
  p_shipping_fees jsonb,
  p_importer_codes text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.work_sessions%rowtype;
  route_group record;
  importer_row public.importer_master%rowtype;
  customer_row public.domestic_customer_master%rowtype;
  generated_sale_id uuid;
  generated_sale_no text;
  generated_source_key text;
  shipping_amount numeric(18,2);
  subtotal_8 numeric(18,2);
  subtotal_10 numeric(18,2);
  tax_8 numeric(18,2);
  tax_10 numeric(18,2);
  total_net numeric(18,2);
  total_tax numeric(18,2);
  total_gross numeric(18,2);
  payment_due date;
  importer_count integer;
  line_count integer;
  direct_importers text[] := array[]::text[];
  domestic_sales jsonb := '[]'::jsonb;
begin
  if not public.is_internal_user() then
    raise exception 'Internal access is required.' using errcode = '42501';
  end if;
  if p_session_id is null or p_work_date is null then
    raise exception '作業データと作業日を確認してください。' using errcode = '22023';
  end if;

  select * into session_row
  from public.work_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception '対象作業が見つかりません。' using errcode = 'P0002';
  end if;
  if session_row.locked or session_row.status = 'closed' then
    raise exception '別の端末で先に売上確定された可能性があります。最新状態を再読込してください。' using errcode = '55000';
  end if;
  if not exists (select 1 from public.sales_records where session_id = p_session_id) then
    raise exception '確定する売上明細が保存されていません。' using errcode = '22023';
  end if;

  select count(distinct public.canonical_importer_code(coalesce(importer_code,importer_id,'')))
  into importer_count
  from public.sales_records
  where session_id = p_session_id
    and public.canonical_importer_code(coalesce(importer_code,importer_id,'')) = any(p_importer_codes);

  update public.sales_records
  set work_date = p_work_date,
      finalized_at = coalesce(p_finalized_at,now()),
      finalized_by = auth.uid(),
      domestic_sale_id = null,
      revenue_recognition_mode = 'direct_export'
  where session_id = p_session_id
    and public.canonical_importer_code(coalesce(importer_code,importer_id,'')) = any(p_importer_codes);

  for route_group in
    select
      public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,'')) as importer_code,
      min(coalesce(s.importer_code,s.importer_id,'')) as source_importer_code
    from public.sales_records s
    where s.session_id = p_session_id
      and public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,'')) = any(p_importer_codes)
    group by public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,''))
    order by public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,''))
  loop
    importer_row := null;
    select m.* into importer_row
    from public.importer_master m
    where public.canonical_importer_code(m.importer_code) = route_group.importer_code
      and m.is_active
    order by
      case when btrim(m.importer_code) = btrim(route_group.source_importer_code) then 0 else 1 end,
      case when btrim(m.importer_code) ~ '^[0-9]+$' then 0 else 1 end,
      m.importer_code
    limit 1;

    if not found or importer_row.revenue_route = 'direct_export' then
      direct_importers := array_append(direct_importers,route_group.importer_code);
      continue;
    end if;

    if importer_row.domestic_customer_code is null then
      raise exception '輸入社 % は国内会社経由ですが、国内請求先が設定されていません。', importer_row.importer_code
        using errcode = '22023';
    end if;

    select * into customer_row
    from public.domestic_customer_master
    where customer_code = importer_row.domestic_customer_code
      and active
    for share;
    if not found then
      raise exception '輸入社 % の有効な国内請求先が見つかりません。', importer_row.importer_code
        using errcode = '22023';
    end if;

    if exists (
      select 1
      from public.accounts_receivable r
      where r.source_session_id = p_session_id
        and public.canonical_importer_code(r.importer_code) = route_group.importer_code
        and (r.closing_id is not null or exists (
          select 1 from public.accounts_receivable_payments p where p.receivable_id = r.id
        ))
    ) then
      raise exception '国内会社経由へ切り替える輸出売掛が締め済みまたは入金済みです。先に売掛を確認してください。'
        using errcode = '55000';
    end if;

    delete from public.accounts_receivable r
    where r.source_session_id = p_session_id
      and public.canonical_importer_code(r.importer_code) = route_group.importer_code
      and r.closing_id is null
      and not exists (select 1 from public.accounts_receivable_payments p where p.receivable_id = r.id);

    update public.sales_records s
    set revenue_recognition_mode = 'customs_only'
    where s.session_id = p_session_id
      and public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,'')) = route_group.importer_code;

    generated_source_key := 'export-intermediary:' || p_session_id::text || ':' || route_group.importer_code;
    if exists (select 1 from public.domestic_sales where source_key = generated_source_key) then
      raise exception '同じ作業・輸入社の国内売上がすでに存在します。二重計上を防ぐため確定を中止しました。'
        using errcode = '23505';
    end if;

    generated_sale_id := gen_random_uuid();
    generated_sale_no := 'DOM-' || to_char(p_work_date,'YYYYMMDD') || '-'
      || lpad(nextval('public.domestic_sale_no_seq')::text,6,'0');

    select coalesce(
      (
        select round((fee.value #>> '{}')::numeric,2)
        from jsonb_each(coalesce(p_shipping_fees,'{}'::jsonb)) fee
        where public.canonical_importer_code(fee.key) = route_group.importer_code
        order by case when btrim(fee.key) = btrim(route_group.source_importer_code) then 0 else 1 end
        limit 1
      ),
      case when importer_count = 1 then round(coalesce(p_shipping_fee,0),2) else 0 end,
      0
    ) into shipping_amount;

    insert into public.domestic_sales (
      id,sale_no,sale_date,customer_code,customer_name_snapshot,status,
      shipping_amount_jpy,memo,confirmed_by,confirmed_at,
      source_type,source_session_id,source_importer_code,source_key
    ) values (
      generated_sale_id,generated_sale_no,p_work_date,customer_row.customer_code,
      customer_row.customer_name,'confirmed',shipping_amount,
      '輸出作業 ' || coalesce(session_row.name,p_session_id::text) || ' / 輸入社 ' || route_group.source_importer_code,
      auth.uid(),coalesce(p_finalized_at,now()),
      'export_intermediary',p_session_id,route_group.importer_code,generated_source_key
    );

    insert into public.domestic_sale_lines (
      sale_id,line_no,product_code,product_name_snapshot,quantity,unit,
      unit_price_jpy,tax_rate,net_amount_jpy,memo,source_sales_record_id
    )
    select
      generated_sale_id,
      row_number() over(order by s.source_row_no)::integer,
      case when exists (
        select 1 from public.product_master p where p.product_id = s.product_id and p.is_active
      ) then s.product_id else null end,
      coalesce(nullif(btrim(s.product_name),''),nullif(btrim(s.product_id),''),'未登録商品'),
      s.input_qty,
      case upper(btrim(coalesce(s.input_unit,'Kg')))
        when 'KG' then 'Kg'
        when 'PKT' then 'pkt'
        when 'PC' then 'PC'
        when 'CS' then 'CS'
        else 'Kg'
      end,
      greatest(coalesce(s.unit_price,0),0),
      8,
      greatest(round(coalesce(s.amount,s.input_qty * s.unit_price,0),0),0),
      concat_ws(' / ',nullif(btrim(s.memo),''),nullif('輸出先: ' || btrim(coalesce(s.store_name,'')),'輸出先: ')),
      s.id
    from public.sales_records s
    where s.session_id = p_session_id
      and public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,'')) = route_group.importer_code
      and not coalesce(s.is_stockout,false)
      and coalesce(s.input_qty,0) > 0
    order by s.source_row_no;

    get diagnostics line_count = row_count;
    if line_count = 0 then
      raise exception '輸入社 % に国内売上へ反映できる数量明細がありません。', route_group.source_importer_code
        using errcode = '22023';
    end if;

    select
      coalesce(sum(net_amount_jpy) filter (where tax_rate = 8),0),
      coalesce(sum(net_amount_jpy) filter (where tax_rate = 10),0)
    into subtotal_8,subtotal_10
    from public.domestic_sale_lines
    where sale_id = generated_sale_id;

    tax_8 := floor(subtotal_8 * 0.08);
    tax_10 := floor((subtotal_10 + shipping_amount) * 0.10);
    total_net := subtotal_8 + subtotal_10 + shipping_amount;
    total_tax := tax_8 + tax_10;
    total_gross := total_net + total_tax;
    payment_due := public.domestic_receivable_due_date(
      p_work_date,customer_row.closing_day,customer_row.payment_month_offset,customer_row.payment_day
    );

    update public.domestic_sales
    set product_subtotal_8_jpy = subtotal_8,
        product_subtotal_10_jpy = subtotal_10,
        total_net_jpy = total_net,
        tax_8_jpy = tax_8,
        tax_10_jpy = tax_10,
        tax_total_jpy = total_tax,
        total_amount_jpy = total_gross
    where id = generated_sale_id;

    insert into public.domestic_receivables (
      source_key,source_type,sale_id,customer_code,customer_name_snapshot,
      invoice_date,due_date,amount_jpy,paid_amount_jpy,balance_jpy,status,memo,created_by,updated_by
    ) values (
      'sale:' || generated_sale_id::text,'sale',generated_sale_id,customer_row.customer_code,
      customer_row.customer_name,p_work_date,payment_due,total_gross,0,total_gross,
      case when total_gross = 0 then 'paid' else 'unpaid' end,
      '輸出作業から自動作成 / ' || route_group.source_importer_code,auth.uid(),auth.uid()
    );

    update public.sales_records s
    set domestic_sale_id = generated_sale_id
    where s.session_id = p_session_id
      and public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,'')) = route_group.importer_code;

    domestic_sales := domestic_sales || jsonb_build_array(jsonb_build_object(
      'id',generated_sale_id,
      'sale_no',generated_sale_no,
      'importer_code',route_group.importer_code,
      'customer_code',customer_row.customer_code,
      'total_amount_jpy',total_gross
    ));
  end loop;

  return jsonb_build_object(
    'session',to_jsonb(session_row),
    'direct_importers',to_jsonb(direct_importers),
    'domestic_sales',domestic_sales
  );
end;
$$;

revoke all on function public.finalize_export_revenue_route_scoped(uuid,date,timestamptz,numeric,jsonb,text[]) from public,anon,authenticated;

create or replace function public.work_importer_finalization_preview(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare w public.work_sessions; version text; groups jsonb;
begin
  if not public.is_internal_user() then raise exception '社内担当者のみ使用できます。' using errcode='42501'; end if;
  select * into w from public.work_sessions where id=p_session_id;
  if not found then raise exception '作業が見つかりません。'; end if;
  select md5(jsonb_build_object('session',to_jsonb(w),
    'source',(select jsonb_agg(x.payload order by x.source_row_no) from public.work_refinalization_source(p_session_id) x),
    'sales',(select jsonb_agg(to_jsonb(s) order by s.id) from public.sales_records s where session_id=p_session_id))::text) into version;
  with source as materialized(select * from public.work_refinalization_source(p_session_id)),
  grouped as (select importer_code,count(*) as line_count,
    count(*) filter(where not coalesce((payload->>'is_stockout')::boolean,false)
      and (coalesce((payload->>'input_qty')::numeric,0)<=0 or coalesce((payload->>'net_weight')::numeric,0)<=0 or nullif(btrim(payload->>'box_no'),'') is null)) as incomplete,
    coalesce(sum((payload->>'amount')::numeric),0) as net_sales
    from source group by importer_code)
  select coalesce(jsonb_agg(to_jsonb(g)||jsonb_build_object(
    'importer_name',coalesce((select m.importer_name from public.importer_master m where public.canonical_importer_code(m.importer_code)=g.importer_code order by (m.importer_code=g.importer_code) desc,m.importer_code limit 1),g.importer_code),
    'finalized',w.locked or g.importer_code=any(w.finalized_importer_codes),
    'shipping',coalesce((select (f.value#>>'{}')::numeric from jsonb_each(w.shipping_fees) f where public.canonical_importer_code(f.key)=g.importer_code order by (f.key=g.importer_code) desc,f.key limit 1),case when (select count(*) from grouped)=1 then w.shipping_fee else 0 end,0)
  ) order by g.importer_code),'[]'::jsonb) into groups from grouped g;
  return jsonb_build_object('session',to_jsonb(w),'version',version,'groups',groups);
end;
$$;

create or replace function public.finalize_work_session_importers(
 p_session_id uuid,p_importer_codes text[],p_shipping_fees jsonb,p_expected_version text,p_allow_incomplete boolean default false
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 w public.work_sessions; preview jsonb; codes text[]; code text; fees jsonb; fee numeric; group_state jsonb;
 source_item record; s public.sales_records; routed jsonb; operation_start date; net numeric; customers jsonb;
 saved integer:=0; pending text[]; completed text[]; previous_context text;
begin
 if not public.is_internal_user() then raise exception '社内担当者のみ使用できます。' using errcode='42501'; end if;
 select * into w from public.work_sessions where id=p_session_id for update;
 if not found then raise exception '作業が見つかりません。'; end if;
 if w.locked or w.status='closed' then raise exception 'すでに売上確定済みです。再読み込みしてください。'; end if;
 if w.finalized_at is not null then raise exception '訂正後の作業は売上再確定を使用してください。'; end if;
 if w.work_date is null then raise exception '作業日を設定してください。'; end if;
 perform 1 from public.order_lines where session_id=p_session_id for update;
 perform 1 from public.boxes where session_id=p_session_id for update;
 perform 1 from public.sales_records where session_id=p_session_id for update;
 select array_agg(distinct public.canonical_importer_code(x) order by public.canonical_importer_code(x)) into codes from unnest(p_importer_codes) x where nullif(btrim(x),'') is not null;
 if coalesce(cardinality(codes),0)=0 then raise exception '確定する輸入社を選択してください。'; end if;
 preview:=public.work_importer_finalization_preview(p_session_id);
 if p_expected_version is null or p_expected_version<>preview->>'version' then raise exception '確認中に作業が更新されました。確定画面を開き直してください。' using errcode='40001'; end if;
 if jsonb_typeof(p_shipping_fees) is distinct from 'object' then raise exception '送料の形式を確認してください。'; end if;
 if exists(select 1 from jsonb_object_keys(p_shipping_fees) k where not(k=any(codes))) then raise exception '選択していない輸入社の送料は変更できません。'; end if;
 if exists(select 1 from unnest(codes) c where c=any(w.finalized_importer_codes)) then raise exception '選択した輸入社は確定済みです。'; end if;
 if exists(select 1 from public.sales_records sr where sr.session_id=p_session_id and public.canonical_importer_code(coalesce(sr.importer_code,sr.importer_id,''))=any(codes)) then
   raise exception '選択した輸入社に既存の売上明細があります。二重計上を防ぐため管理者の確認が必要です。';
 end if;
 if exists(select 1 from public.accounts_receivable r where r.source_session_id=p_session_id and public.canonical_importer_code(r.importer_code)=any(codes))
 or exists(select 1 from public.domestic_sales d where d.source_session_id=p_session_id and public.canonical_importer_code(d.source_importer_code)=any(codes)) then
   raise exception '選択した輸入社の請求データが存在します。管理者が確認してください。';
 end if;
 fees:=coalesce(w.shipping_fees,'{}'::jsonb);
 foreach code in array codes loop
   select value into group_state from jsonb_array_elements(preview->'groups') where value->>'importer_code'=code;
   if group_state is null or code='' then raise exception '輸入社 % の明細がありません。',code; end if;
   if (group_state->>'incomplete')::integer>0 and not(coalesce(p_allow_incomplete,false) and public.is_master_admin()) then raise exception '未完了明細があります。管理者の確認が必要です。'; end if;
   fee:=(p_shipping_fees->>code)::numeric;
   if fee is null or fee<0 or fee<>round(fee,0) then raise exception '送料は0以上の整数で入力してください。'; end if;
   select coalesce(jsonb_object_agg(k,v),'{}'::jsonb) into fees from jsonb_each(fees) e(k,v) where public.canonical_importer_code(k)<>code;
   fees:=fees||jsonb_build_object(code,fee);
 end loop;
 previous_context:=current_setting('app.importer_finalization_session',true);
 perform set_config('app.importer_finalization_session',p_session_id::text,true);
 perform set_config('app.audit_source','importer-sales-finalization',true);
 for source_item in select * from public.work_refinalization_source(p_session_id) where importer_code=any(codes) order by source_row_no loop
   s:=jsonb_populate_record(null::public.sales_records,source_item.payload);
   insert into public.sales_records(session_id,source_row_no,work_date,finalized_at,finalized_by,country_code,importer_id,importer_code,store_name,product_id,product_name,english_name,scientific_name,origin,ordered_qty,ordered_unit,input_qty,input_unit,net_weight,box_no,gross_weight,dry_ice_enabled,dry_ice_weight,box_size,unit_price,amount,memo,is_stockout,site_code)
   values(s.session_id,s.source_row_no,s.work_date,now(),auth.uid(),s.country_code,s.importer_id,s.importer_code,s.store_name,s.product_id,s.product_name,s.english_name,s.scientific_name,s.origin,s.ordered_qty,s.ordered_unit,s.input_qty,s.input_unit,s.net_weight,s.box_no,s.gross_weight,s.dry_ice_enabled,s.dry_ice_weight,s.box_size,s.unit_price,s.amount,s.memo,s.is_stockout,s.site_code);
   saved:=saved+1;
 end loop;
 routed:=public.finalize_export_revenue_route_scoped(p_session_id,w.work_date,now(),(select sum((v#>>'{}')::numeric) from jsonb_each(p_shipping_fees) e(k,v)),p_shipping_fees,codes);
 select coalesce(operation_start_date,date '2026-08-01') into operation_start from public.accounts_receivable_settings where singleton=true;
 operation_start:=coalesce(operation_start,date '2026-08-01');
 if w.work_date>=operation_start then
   for code in select jsonb_array_elements_text(routed->'direct_importers') loop
     select coalesce(sum(amount) filter(where not is_stockout),0),coalesce(jsonb_agg(distinct store_name) filter(where not is_stockout and nullif(btrim(store_name),'') is not null),'[]'::jsonb) into net,customers from public.sales_records sr where session_id=p_session_id and public.canonical_importer_code(coalesce(sr.importer_code,sr.importer_id,''))=code;
     select value into group_state from jsonb_array_elements(preview->'groups') where value->>'importer_code'=code;
     fee:=(fees->>code)::numeric;
     if net+fee=0 then continue; end if;
     insert into public.accounts_receivable(source_key,source_type,source_session_id,importer_code,importer_name,customer_name,customer_names,invoice_no,invoice_date,currency,net_sales_jpy,shipping_amount_jpy,amount_jpy,created_by,updated_by)
     values('sales:'||p_session_id::text||':'||code,'sales',p_session_id,code,group_state->>'importer_name',case when jsonb_array_length(customers)>1 then (customers->>0)||' 他'||(jsonb_array_length(customers)-1)||'件' else coalesce(customers->>0,'') end,customers,
       case when code~'^[0-9]{1,3}$' then to_char(w.work_date,'YYYYMMDD')||lpad(code,3,'0') else to_char(w.work_date,'YYYYMMDD')||code end,w.work_date,'JPY',net,fee,net+fee,auth.uid(),auth.uid());
   end loop;
 end if;
 select array_agg(distinct c order by c) into completed from unnest(w.finalized_importer_codes||codes) c;
 select coalesce(array_agg(distinct x.importer_code order by x.importer_code),'{}'::text[]) into pending from public.work_refinalization_source(p_session_id) x where not(x.importer_code=any(completed));
 update public.work_sessions set finalized_importer_codes=completed,shipping_fees=fees,
   shipping_fee=(select coalesce(sum((v#>>'{}')::numeric),0) from jsonb_each(fees) e(k,v)),
   locked=cardinality(pending)=0,status=case when cardinality(pending)=0 then 'closed' else 'active' end,
   finalized_at=case when cardinality(pending)=0 then now() else null end,
   finalized_by=case when cardinality(pending)=0 then auth.uid() else null end
 where id=p_session_id returning * into w;
 foreach code in array codes loop
   insert into public.sales_correction_log(action_type,session_id,importer_code,old_values,new_values,reason,changed_by)
   values('sales_record',p_session_id,code,'{}'::jsonb,jsonb_build_object('finalized',true,'shipping',fees->code),'輸入社別の初回売上確定',auth.uid());
 end loop;
 perform set_config('app.importer_finalization_session',coalesce(previous_context,''),true);
 return jsonb_build_object('session',to_jsonb(w),'saved_rows',saved,'importer_codes',codes,'pending_importers',pending);
end;
$$;

-- Direct client writes cannot bypass the lock, even for admins.
-- Existing privileged admin correction RPCs retain their established access.
create or replace function public.guard_importer_finalized_detail()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare item jsonb; w public.work_sessions; code text;
begin
 for item in select value from jsonb_array_elements(case when tg_op='INSERT' then jsonb_build_array(to_jsonb(new)) when tg_op='DELETE' then jsonb_build_array(to_jsonb(old)) else jsonb_build_array(to_jsonb(old),to_jsonb(new)) end) loop
   select * into w from public.work_sessions where id=(item->>'session_id')::uuid for share;
   code:=public.canonical_importer_code(coalesce(item->>'importer_code',item->>'importer_id',''));
   if code=any(w.finalized_importer_codes) and (tg_op='INSERT' or current_user in ('authenticated','anon') or not public.is_master_admin()) then
     raise exception '輸入社 % は売上確定済みのため変更できません。',code using errcode='55000';
   end if;
 end loop;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;
drop trigger if exists trg_guard_importer_finalized_order on public.order_lines;
create trigger trg_guard_importer_finalized_order before insert or update or delete on public.order_lines for each row execute function public.guard_importer_finalized_detail();
drop trigger if exists trg_guard_importer_finalized_box on public.boxes;
create trigger trg_guard_importer_finalized_box before insert or update or delete on public.boxes for each row execute function public.guard_importer_finalized_detail();
drop trigger if exists trg_guard_importer_finalized_sale on public.sales_records;
create trigger trg_guard_importer_finalized_sale before insert or update or delete on public.sales_records for each row execute function public.guard_importer_finalized_detail();

create or replace function public.guard_importer_finalization_state()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if old.locked and not new.locked and public.is_master_admin() then new.finalized_importer_codes:='{}'; return new; end if;
 if current_setting('app.importer_finalization_session',true)=new.id::text then return new; end if;
 if new.finalized_importer_codes is distinct from old.finalized_importer_codes then raise exception '輸入社の確定状態は売上確定処理から更新してください。'; end if;
 if cardinality(old.finalized_importer_codes)>0 and (new.work_date is distinct from old.work_date or new.site_code is distinct from old.site_code or new.locked is distinct from old.locked or new.status is distinct from old.status or new.finalized_at is distinct from old.finalized_at) then
   raise exception '輸入社別の売上確定を使用してください。確定済みの拠点・作業日は変更できません。';
 end if;
 return new;
end;
$$;
drop trigger if exists trg_guard_importer_finalization_state on public.work_sessions;
create trigger trg_guard_importer_finalization_state before update on public.work_sessions for each row execute function public.guard_importer_finalization_state();

revoke all on function public.work_importer_finalization_preview(uuid) from public,anon;
revoke all on function public.finalize_work_session_importers(uuid,text[],jsonb,text,boolean) from public,anon;
revoke all on function public.guard_importer_finalized_detail() from public,anon,authenticated;
revoke all on function public.guard_importer_finalization_state() from public,anon,authenticated;
grant execute on function public.work_importer_finalization_preview(uuid) to authenticated;
grant execute on function public.finalize_work_session_importers(uuid,text[],jsonb,text,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
