-- Atomic field additions and explicit supplier recovery. No financial backfill.
begin;

create or replace function public.save_work_additional_order(
  p_session_id uuid,
  p_request_id uuid,
  p_order jsonb,
  p_existing_source_row_no integer default null
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  session_row public.work_sessions%rowtype;
  work_row public.order_lines%rowtype;
  supplier_row public.supplier_master%rowtype;
  importer_row public.importer_master%rowtype;
  customer_row public.customer_master%rowtype;
  prior_line public.order_entry_lines%rowtype;
  order_data jsonb;
  marker text;
  next_no integer;
  customer_matches integer;
  importer_matches integer;
  repair boolean := p_existing_source_row_no is not null;
begin
  if auth.uid() is null or not coalesce(public.is_internal_user(),false) then
    raise exception '社内ユーザーのみ追加・発注先補完が可能です。';
  end if;
  if p_request_id is null or jsonb_typeof(p_order) is distinct from 'object' then
    raise exception '追加注文の入力内容を確認してください。';
  end if;
  -- The parent lock serializes numbering, finalization and concurrent additions.
  select * into session_row from public.work_sessions where id=p_session_id for update;
  if not found then raise exception '作業が見つかりません。'; end if;
  if session_row.work_date is null then raise exception '作業日を設定してください。'; end if;
  marker:=jsonb_build_object('kind',case when repair then 'work-supplier-repair' else 'work-additional-order' end,
                            'request',p_order,'user',auth.uid())::text;
  select * into prior_line from public.order_entry_lines where id=p_request_id;
  if found then
    select * into work_row from public.order_lines where session_id=p_session_id and source_order_line_id=p_request_id;
    if work_row.id is null or prior_line.source_text is distinct from marker then
      raise exception '保存要求が重複しています。最新状態を確認してください。';
    end if;
    return to_jsonb(work_row);
  end if;
  if coalesce(session_row.locked,false) or coalesce(session_row.provisional_locked,false)
     or session_row.status='closed' then
    if not repair then raise exception '仮締め・売上確定済みです。解除後に追加してください。'; end if;
    if not coalesce(public.is_master_admin(),false) then raise exception '確定済み作業の発注先補完は管理者のみ可能です。'; end if;
  end if;
  if exists(select 1 from public.sales_records where session_id=p_session_id)
     and not coalesce(public.is_master_admin(),false) then
    raise exception '売上確定済み作業の訂正は管理者のみ可能です。';
  end if;
  select * into supplier_row from public.supplier_master
  where supplier_code=btrim(p_order->>'supplier_code') and is_active;
  if not found then raise exception '有効な発注先コードを選択してください。'; end if;
  if repair then
    select * into work_row from public.order_lines
    where session_id=p_session_id and source_row_no=p_existing_source_row_no for update;
    if not found then raise exception '元の作業明細がありません。発注入力から確認してください。'; end if;
    if work_row.id::text is distinct from p_order->>'expected_id'
       or work_row.updated_at is distinct from (p_order->>'expected_updated_at')::timestamptz then
      raise exception '確認中に明細が更新されました。再読込してください。' using errcode='40001';
    end if;
    if work_row.source_order_line_id is not null then
      select * into prior_line from public.order_entry_lines where id=work_row.source_order_line_id for update;
      if nullif(btrim(prior_line.supplier_code),'') is not null then
        if prior_line.supplier_code=supplier_row.supplier_code then return to_jsonb(work_row); end if;
        raise exception '発注先は既に設定されています。発注先確認から変更してください。';
      end if;
      if public.update_order_supplier_review(array[prior_line.id],supplier_row.supplier_code,false)<>1 then
        raise exception '受注明細の発注先を補完できませんでした。';
      end if;
      return to_jsonb(work_row);
    end if;
    order_data:=jsonb_build_object('importer_code',coalesce(nullif(work_row.importer_code,''),work_row.importer_id),
      'customer_name',work_row.store_name,'product_code',work_row.product_id,'product_name',work_row.product_name,
      'order_qty',work_row.ordered_qty,'order_unit',work_row.ordered_unit,'origin',work_row.origin,
      'unit_price',work_row.unit_price,'english_name',work_row.english_name,'scientific_name',work_row.scientific_name,'memo',work_row.memo);
  else
    order_data:=p_order;
    if nullif(btrim(order_data->>'product_name'),'') is null
       or nullif(btrim(order_data->>'customer_name'),'') is null
       or coalesce((order_data->>'order_qty')::numeric,0)<=0
       or nullif(btrim(order_data->>'order_unit'),'') is null then
      raise exception '得意先・商品名・注文数量・注文単位を入力してください。';
    end if;
    if (order_data->>'unit_price')::numeric<0 then raise exception '売価は0以上で入力してください。'; end if;
    if (order_data->>'order_qty')::numeric::text in ('NaN','Infinity','-Infinity')
       or (order_data->>'unit_price')::numeric::text in ('NaN','Infinity','-Infinity') then
      raise exception '数量・売価は有限の数値で入力してください。';
    end if;
    if (order_data->>'order_qty')::numeric<>round((order_data->>'order_qty')::numeric,3) then
      raise exception '注文数量は小数第3位までで入力してください。';
    end if;
    if nullif(btrim(order_data->>'product_code'),'') is null then
      order_data:=order_data||jsonb_build_object('product_code','ADD-'||replace(p_request_id::text,'-',''));
    end if;
  end if;
  select count(*) into importer_matches from public.importer_master
    where is_active and (importer_code=btrim(order_data->>'importer_code')
      or (repair and lower(importer_name)=lower(btrim(order_data->>'importer_code'))));
  if importer_matches<>1 then raise exception '輸入社コードを一意に確認できません。マスタを確認してください。'; end if;
  select * into importer_row from public.importer_master
    where is_active and (importer_code=btrim(order_data->>'importer_code')
      or (repair and lower(importer_name)=lower(btrim(order_data->>'importer_code'))));
  if not repair and nullif(order_data->>'customer_id','') is not null then
    select * into customer_row from public.customer_master where id=(order_data->>'customer_id')::uuid and active;
    if not found or customer_row.importer_code is distinct from importer_row.importer_code
       or customer_row.site_code is distinct from session_row.site_code
       or customer_row.customer_name is distinct from order_data->>'customer_name' then
      raise exception '得意先の輸入社・拠点が作業と一致しません。';
    end if;
  else
    -- Existing work names without codes may be preserved, but are never guessed.
    if not repair and not exists(select 1 from public.order_lines l where l.session_id=p_session_id
       and l.store_name=order_data->>'customer_name'
       and (l.importer_code=importer_row.importer_code or l.importer_id=importer_row.importer_code)) then
      raise exception '得意先マスタまたは現在の作業から得意先を選択してください。';
    end if;
    select count(*) into customer_matches from public.customer_master where active
      and importer_code=importer_row.importer_code and site_code=session_row.site_code
      and customer_name=order_data->>'customer_name';
    if customer_matches=1 then
      select * into customer_row from public.customer_master where active
        and importer_code=importer_row.importer_code and site_code=session_row.site_code
        and customer_name=order_data->>'customer_name';
    end if;
  end if;
  insert into public.order_entry_batches(id,order_date,ship_date,site_code,importer_code,importer_name_snapshot,
    customer_code,customer_name_snapshot,status,source_type,note,confirmed_at)
  values(p_request_id,session_row.work_date,session_row.work_date,session_row.site_code,importer_row.importer_code,
    importer_row.importer_name,customer_row.customer_code,order_data->>'customer_name','confirmed','system',
    case when repair then '作業明細の発注先補完' else '現場追加オーダー' end,now());
  insert into public.order_entry_lines(id,batch_id,line_no,product_code,product_name_snapshot,english_name_snapshot,
    order_qty,order_unit,supplier_code,supplier_name_snapshot,purchase_note,unit_price,source_text)
  values(p_request_id,p_request_id,1,order_data->>'product_code',coalesce(order_data->>'product_name','商品名未設定'),
    order_data->>'english_name',(order_data->>'order_qty')::numeric,order_data->>'order_unit',
    supplier_row.supplier_code,supplier_row.supplier_name,order_data->>'memo',(order_data->>'unit_price')::numeric,marker);
  if repair then
    update public.order_lines set source_order_line_id=p_request_id,updated_by=auth.uid()
    where id=work_row.id returning * into work_row;
  else
    select coalesce(max(source_row_no),0)+1 into next_no from public.order_lines where session_id=p_session_id;
    insert into public.order_lines(session_id,source_row_no,source_order_line_id,country_code,importer_id,importer_code,
      store_name,product_id,product_name,ordered_qty,ordered_unit,unit_price,english_name,scientific_name,origin,input_unit,memo,updated_by)
    values(p_session_id,next_no,p_request_id,importer_row.importer_code,importer_row.importer_code,importer_row.importer_code,
      order_data->>'customer_name',order_data->>'product_code',order_data->>'product_name',(order_data->>'order_qty')::numeric,
      order_data->>'order_unit',(order_data->>'unit_price')::numeric,order_data->>'english_name',order_data->>'scientific_name',
      order_data->>'origin','Kg',order_data->>'memo',auth.uid()) returning * into work_row;
  end if;
  return to_jsonb(work_row);
end;
$$;
revoke all on function public.save_work_additional_order(uuid,uuid,jsonb,integer) from public,anon;
grant execute on function public.save_work_additional_order(uuid,uuid,jsonb,integer) to authenticated;
notify pgrst,'reload schema';
commit;
