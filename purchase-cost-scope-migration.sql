begin;

-- Classification is apart from financial rows so paid/closed purchases stay unchanged.
create table if not exists public.purchase_line_cost_scopes (
  purchase_line_id uuid primary key references public.purchase_receipt_lines(id) on delete cascade,
  scope text not null check (scope in ('importer','shared','domestic')),
  importer_code text references public.importer_master(importer_code),
  assignment_method text not null default 'manual' check (assignment_method = 'manual'),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  check ((scope = 'importer' and importer_code is not null)
      or (scope <> 'importer' and importer_code is null))
);
create table if not exists public.purchase_cost_scope_log (
  id bigint generated always as identity primary key,
  purchase_line_id uuid not null references public.purchase_receipt_lines(id) on delete cascade,
  before_scope jsonb,
  after_scope jsonb not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_purchase_cost_scope_log_line
  on public.purchase_cost_scope_log(purchase_line_id,created_at);
create index if not exists idx_purchase_sales_links_line
  on public.purchase_sales_links(purchase_line_id);
alter table public.purchase_line_cost_scopes enable row level security;
alter table public.purchase_cost_scope_log enable row level security;
drop policy if exists purchase_cost_scope_internal_read on public.purchase_line_cost_scopes;
create policy purchase_cost_scope_internal_read on public.purchase_line_cost_scopes
  for select to authenticated using (public.is_internal_user());
drop policy if exists purchase_cost_scope_log_internal_read on public.purchase_cost_scope_log;
create policy purchase_cost_scope_log_internal_read on public.purchase_cost_scope_log
  for select to authenticated using (public.is_internal_user());
revoke all on public.purchase_line_cost_scopes, public.purchase_cost_scope_log from public, anon, authenticated;
grant select on public.purchase_line_cost_scopes, public.purchase_cost_scope_log to authenticated;

create or replace function public.resolve_purchase_cost_importer(p_value text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  with exact_code as (
    select importer_code from public.importer_master where importer_code = btrim(p_value)
  ), matches as (
    select importer_code from exact_code
    union
    select m.importer_code from public.importer_master m
    where not exists(select 1 from exact_code) and (
      (case when m.importer_code ~ '^[0-9]{1,3}$' then m.importer_code::integer end
        = case when btrim(p_value) ~ '^[0-9]{1,3}$' then btrim(p_value)::integer end)
      or lower(btrim(m.importer_name)) = lower(btrim(p_value))
      or exists(select 1 from unnest(m.aliases) a where lower(btrim(a)) = lower(btrim(p_value)))
    )
  )
  select case when count(*) = 1 then min(importer_code) end from matches;
$$;

create or replace function public.get_purchase_line_cost_scopes(p_line_ids uuid[])
returns table(purchase_line_id uuid, scope text, importer_code text, assignment_method text, editable boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_internal_user() then raise exception 'Internal access is required.'; end if;
  return query
  with requested as materialized (
    select l.id, l.source_assignment_line_id from public.purchase_receipt_lines l
    where l.id = any(coalesce(p_line_ids,'{}'::uuid[]))
  ), source_codes as materialized (
    select link.purchase_line_id,
      coalesce(public.resolve_purchase_cost_importer(s.importer_code),
        public.resolve_purchase_cost_importer(s.importer_id)) code
    from requested r join public.purchase_sales_links link on link.purchase_line_id = r.id
    left join public.sales_records s on s.id = link.sales_record_id
  ), source_groups as (
    select s.purchase_line_id, count(*) source_count,
      count(*) filter(where s.code is null) unknown_count,
      count(distinct s.code) importer_count, min(s.code) code
    from source_codes s group by s.purchase_line_id
  ), resolved as (
    select r.id, g.source_count, g.unknown_count, g.importer_count, g.code,
      e.id external_id, public.resolve_purchase_cost_importer(e.importer_code) external_code,
      m.scope manual_scope, m.importer_code manual_code
    from requested r left join source_groups g on g.purchase_line_id = r.id
    left join public.external_work_assignment_lines e on e.id = r.source_assignment_line_id
    left join public.purchase_line_cost_scopes m on m.purchase_line_id = r.id
  )
  select r.id,
    case when r.source_count > 0 then
        case when r.unknown_count > 0 then 'unassigned' when r.importer_count = 1 then 'importer' else 'shared' end
      when r.external_id is not null then case when r.external_code is null then 'unassigned' else 'importer' end
      else coalesce(r.manual_scope,'unassigned') end,
    case when r.source_count > 0 then case when r.unknown_count = 0 and r.importer_count = 1 then r.code end
      when r.external_id is not null then r.external_code else r.manual_code end,
    case when r.source_count > 0 then 'auto_sales' when r.external_id is not null then 'auto_external'
      when r.manual_scope is not null then 'manual' else 'unassigned' end,
    coalesce(r.source_count,0) = 0 and r.external_id is null
  from resolved r;
end;
$$;

create or replace function public.set_purchase_line_cost_scope(
  p_purchase_line_id uuid, p_scope text, p_importer_code text default null
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_resolved record; v_code text; v_before jsonb; v_after jsonb;
begin
  if not public.is_internal_user() then raise exception 'Internal access is required.'; end if;
  perform 1 from public.purchase_receipt_lines l join public.purchase_receipts r on r.id=l.receipt_id
    where l.id=p_purchase_line_id and r.status <> 'cancelled' for update of l;
  if not found then raise exception 'Purchase line not found.'; end if;
  select * into v_resolved from public.get_purchase_line_cost_scopes(array[p_purchase_line_id]);
  if not v_resolved.editable then raise exception 'Source-linked classification is automatic.'; end if;
  if p_scope is null or p_scope not in ('importer','shared','domestic') then
    raise exception 'Select an importer, shared purchase or domestic purchase.';
  end if;
  if p_scope='importer' then
    v_code := public.resolve_purchase_cost_importer(p_importer_code);
    if v_code is null or not exists(select 1 from public.importer_master where importer_code=v_code and is_active) then
      raise exception 'Active importer not found: %', p_importer_code;
    end if;
  elsif nullif(btrim(p_importer_code),'') is not null then
    raise exception 'Importer must be empty for shared/domestic purchases.';
  end if;
  select to_jsonb(m) into v_before from public.purchase_line_cost_scopes m where m.purchase_line_id=p_purchase_line_id;
  insert into public.purchase_line_cost_scopes(purchase_line_id,scope,importer_code,updated_by)
    values(p_purchase_line_id,p_scope,v_code,auth.uid())
    on conflict(purchase_line_id) do update set scope=excluded.scope,importer_code=excluded.importer_code,
      updated_by=excluded.updated_by,updated_at=now()
    returning to_jsonb(purchase_line_cost_scopes.*) into v_after;
  insert into public.purchase_cost_scope_log(purchase_line_id,before_scope,after_scope,created_by)
    values(p_purchase_line_id,v_before,v_after,auth.uid());
end;
$$;

create or replace function public.get_purchase_cost_scope_summary(
  p_from date default null, p_to date default null, p_site_code text default null
)
returns table(scope text, importer_code text, amount numeric, line_count bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_ids uuid[];
begin
  if not public.is_internal_user() then raise exception 'Internal access is required.'; end if;
  if p_from > p_to then raise exception 'Invalid purchase period.'; end if;
  select array_agg(l.id) into v_ids from public.purchase_receipts r
    join public.purchase_receipt_lines l on l.receipt_id=r.id
    where r.status='confirmed' and (p_from is null or r.purchase_date>=p_from)
      and (p_to is null or r.purchase_date<=p_to)
      and (nullif(p_site_code,'') is null or r.site_code=p_site_code);
  return query
  with receipts as materialized (
    select r.* from public.purchase_receipts r
    where r.status='confirmed' and (p_from is null or r.purchase_date>=p_from)
      and (p_to is null or r.purchase_date<=p_to)
      and (nullif(p_site_code,'') is null or r.site_code=p_site_code)
  ), lines as materialized (
    select l.id,l.receipt_id,l.line_amount from receipts r join public.purchase_receipt_lines l on l.receipt_id=r.id
  ), parts as (
    select s.scope,s.importer_code,sum(coalesce(l.line_amount,0)) amount,count(*) line_count
    from lines l join public.get_purchase_line_cost_scopes(v_ids) s on s.purchase_line_id=l.id
    group by s.scope,s.importer_code
    union all
    select 'unassigned',null::text,sum(r.subtotal-coalesce(t.amount,0)),count(*)
    from receipts r left join (select l.receipt_id,sum(l.line_amount) amount from lines l group by l.receipt_id) t on t.receipt_id=r.id
    where r.subtotal<>coalesce(t.amount,0) having count(*)>0
    union all
    select 'fees',null::text,coalesce(sum(r.shipping_fee+r.other_fee),0),
      count(*) filter(where r.shipping_fee+r.other_fee<>0) from receipts r
  )
  select p.scope,p.importer_code,sum(p.amount),sum(p.line_count)::bigint from parts p group by p.scope,p.importer_code;
end;
$$;

create or replace function public.create_confirmed_purchase_batch_v6(
  p_purchase_date date, p_site_code text, p_supplier_code text,
  p_supplier_invoice_no text default null, p_note text default null,
  p_entry_type text default 'purchase', p_lines jsonb default '[]'::jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_receipt_id uuid; v_line_id uuid; v_line jsonb; v_source uuid; v_seen uuid[] := '{}';
  v_supplier_name text; v_qty numeric; v_price numeric; v_unit text; v_price_unit text; v_tax smallint;
  v_has_sources boolean := false; v_credit boolean := p_entry_type='credit_note';
begin
  if not public.is_internal_user() then raise exception 'Internal access is required.'; end if;
  if p_entry_type is null or p_entry_type not in ('purchase','credit_note') then raise exception 'Invalid purchase entry type.'; end if;
  if p_purchase_date is null then raise exception 'Purchase date is required.'; end if;
  if not exists(select 1 from public.site_master where site_code=p_site_code and is_active) then
    raise exception 'Site not found: %',p_site_code;
  end if;
  select supplier_name into v_supplier_name from public.supplier_master where supplier_code=p_supplier_code and is_active;
  if v_supplier_name is null then raise exception 'Supplier not found: %',p_supplier_code; end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'Purchase lines must be an array.'; end if;
  if jsonb_array_length(p_lines) not between 1 and 500 then raise exception 'Purchase lines must contain between 1 and 500 rows.'; end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line)<>'object' then raise exception 'Invalid purchase line.'; end if;
    if v_line ? 'source_sales_ids' and jsonb_typeof(v_line->'source_sales_ids')<>'array' then
      raise exception 'source_sales_ids must be an array.';
    end if;
    for v_source in select value::uuid from jsonb_array_elements_text(coalesce(v_line->'source_sales_ids','[]'::jsonb)) loop
      if v_source is null or v_source=any(v_seen) or exists(select 1 from public.purchase_sales_links where sales_record_id=v_source) then
        raise exception using errcode='23505',message='Sales record has already been imported.';
      end if;
      perform 1 from public.sales_records where id=v_source for share;
      if not found then raise exception 'Source sales record not found: %',v_source; end if;
      v_seen:=array_append(v_seen,v_source); v_has_sources:=true;
    end loop;
  end loop;
  insert into public.purchase_receipts(receipt_type,status,site_code,supplier_code,supplier_name_snapshot,
    purchase_date,supplier_invoice_no,invoice_date,subtotal,tax_amount,tax_override,total_amount,note,created_by)
  values(case when v_credit then 'credit_note' when v_has_sources then 'order' else 'advance' end,
    'expected',p_site_code,p_supplier_code,v_supplier_name,p_purchase_date,nullif(btrim(p_supplier_invoice_no),''),
    case when nullif(btrim(p_supplier_invoice_no),'') is not null then p_purchase_date end,
    0,0,false,0,nullif(btrim(p_note),''),auth.uid()) returning id into v_receipt_id;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_qty:=nullif(btrim(v_line->>'actual_qty'),'')::numeric;
    v_price:=nullif(btrim(v_line->>'unit_price'),'')::numeric;
    v_unit:=coalesce(nullif(btrim(v_line->>'actual_unit'),''),'Kg');
    v_price_unit:=coalesce(nullif(btrim(v_line->>'price_unit'),''),'Kg');
    v_tax:=coalesce(nullif(btrim(v_line->>'tax_rate'),'')::smallint,8);
    if nullif(btrim(v_line->>'product_name'),'') is null then raise exception 'Product name is required.'; end if;
    if v_qty is null or v_qty<=0 or v_qty::text in ('NaN','Infinity','-Infinity') then raise exception 'Actual quantity must be greater than zero.'; end if;
    if v_price is null or v_price<0 or v_price::text in ('NaN','Infinity','-Infinity') then raise exception 'Unit price must be zero or greater.'; end if;
    if v_unit not in ('Kg','pkt','PC','CS') or v_price_unit not in ('Kg','pkt','PC','CS') then raise exception 'Invalid purchase unit.'; end if;
    if v_tax not in (0,8,10) then raise exception 'Invalid tax rate.'; end if;
    if v_credit then v_qty:=-v_qty; end if;
    insert into public.purchase_receipt_lines(receipt_id,product_code,product_name,origin,actual_qty,actual_unit,
      unit_price,price_unit,tax_rate,line_amount,track_inventory,note)
    values(v_receipt_id,nullif(btrim(v_line->>'product_code'),''),btrim(v_line->>'product_name'),
      nullif(btrim(v_line->>'origin'),''),v_qty,v_unit,v_price,v_price_unit,v_tax,round(v_qty*v_price),false,
      nullif(btrim(v_line->>'note'),'')) returning id into v_line_id;
    if jsonb_array_length(coalesce(v_line->'source_sales_ids','[]'::jsonb))>0 then
      for v_source in select value::uuid from jsonb_array_elements_text(v_line->'source_sales_ids') loop
        insert into public.purchase_sales_links(sales_record_id,purchase_receipt_id,purchase_line_id,created_by)
          values(v_source,v_receipt_id,v_line_id,auth.uid());
      end loop;
    else
      perform public.set_purchase_line_cost_scope(v_line_id,v_line->>'cost_scope',v_line->>'cost_importer_code');
    end if;
  end loop;
  perform public.confirm_purchase_receipt(v_receipt_id);
  return v_receipt_id;
end;
$$;

revoke all on function public.resolve_purchase_cost_importer(text) from public,anon,authenticated;
revoke all on function public.get_purchase_line_cost_scopes(uuid[]) from public,anon;
revoke all on function public.set_purchase_line_cost_scope(uuid,text,text) from public,anon;
revoke all on function public.get_purchase_cost_scope_summary(date,date,text) from public,anon;
revoke all on function public.create_confirmed_purchase_batch_v6(date,text,text,text,text,text,jsonb) from public,anon;
grant execute on function public.get_purchase_line_cost_scopes(uuid[]) to authenticated;
grant execute on function public.set_purchase_line_cost_scope(uuid,text,text) to authenticated;
grant execute on function public.get_purchase_cost_scope_summary(date,date,text) to authenticated;
grant execute on function public.create_confirmed_purchase_batch_v6(date,text,text,text,text,text,jsonb) to authenticated;

-- Extend an installed snapshot exporter without replacing its current authorization/behavior.
do $$
declare v_oid regprocedure; v_definition text; v_table text;
begin
  v_oid:=to_regprocedure('public.create_business_snapshot(text)');
  if v_oid is not null then
    select pg_get_functiondef(v_oid) into v_definition;
    foreach v_table in array array['purchase_sales_links','purchase_line_cost_scopes','purchase_cost_scope_log'] loop
      if position(quote_literal(v_table) in v_definition)=0 then
        if position(quote_literal('purchase_receipt_lines')||',' in v_definition)=0 then
          raise exception 'Snapshot purchase table anchor is missing.';
        end if;
        v_definition:=replace(v_definition,quote_literal('purchase_receipt_lines')||',',
          quote_literal('purchase_receipt_lines')||','||quote_literal(v_table)||',');
      end if;
    end loop;
    execute v_definition;
  end if;
end;
$$;
notify pgrst,'reload schema';
commit;
