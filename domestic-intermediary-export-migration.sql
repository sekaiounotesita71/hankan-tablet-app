-- Route exports billed through a domestic company without recognizing revenue twice.
-- Run after domestic-sales-migration.sql and accounts-receivable-reconciliation-migration.sql.

begin;

alter table public.importer_master
  add column if not exists revenue_route text not null default 'direct_export',
  add column if not exists domestic_customer_code text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'importer_master_revenue_route_check'
      and conrelid = 'public.importer_master'::regclass
  ) then
    alter table public.importer_master
      add constraint importer_master_revenue_route_check
      check (revenue_route in ('direct_export','domestic_intermediary'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'importer_master_domestic_customer_code_fkey'
      and conrelid = 'public.importer_master'::regclass
  ) then
    alter table public.importer_master
      add constraint importer_master_domestic_customer_code_fkey
      foreign key (domestic_customer_code)
      references public.domestic_customer_master(customer_code)
      on update cascade on delete restrict;
  end if;
end $$;

alter table public.sales_records
  add column if not exists revenue_recognition_mode text not null default 'direct_export',
  add column if not exists domestic_sale_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sales_records_revenue_recognition_mode_check'
      and conrelid = 'public.sales_records'::regclass
  ) then
    alter table public.sales_records
      add constraint sales_records_revenue_recognition_mode_check
      check (revenue_recognition_mode in ('direct_export','customs_only'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'sales_records_domestic_sale_id_fkey'
      and conrelid = 'public.sales_records'::regclass
  ) then
    alter table public.sales_records
      add constraint sales_records_domestic_sale_id_fkey
      foreign key (domestic_sale_id)
      references public.domestic_sales(id)
      on delete restrict;
  end if;
end $$;

alter table public.domestic_sales
  add column if not exists source_type text not null default 'manual',
  add column if not exists source_session_id uuid,
  add column if not exists source_importer_code text,
  add column if not exists source_key text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'domestic_sales_source_type_check'
      and conrelid = 'public.domestic_sales'::regclass
  ) then
    alter table public.domestic_sales
      add constraint domestic_sales_source_type_check
      check (source_type in ('manual','export_intermediary'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'domestic_sales_source_session_id_fkey'
      and conrelid = 'public.domestic_sales'::regclass
  ) then
    alter table public.domestic_sales
      add constraint domestic_sales_source_session_id_fkey
      foreign key (source_session_id)
      references public.work_sessions(id)
      on delete restrict;
  end if;
end $$;

create unique index if not exists uq_domestic_sales_source_key
  on public.domestic_sales(source_key)
  where source_key is not null;
create index if not exists idx_domestic_sales_source_session
  on public.domestic_sales(source_session_id, source_importer_code);

alter table public.domestic_sale_lines
  add column if not exists source_sales_record_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'domestic_sale_lines_source_sales_record_id_fkey'
      and conrelid = 'public.domestic_sale_lines'::regclass
  ) then
    alter table public.domestic_sale_lines
      add constraint domestic_sale_lines_source_sales_record_id_fkey
      foreign key (source_sales_record_id)
      references public.sales_records(id)
      on delete restrict;
  end if;
end $$;

create unique index if not exists uq_domestic_sale_lines_source_sales_record
  on public.domestic_sale_lines(source_sales_record_id)
  where source_sales_record_id is not null;

create or replace function public.guard_customs_only_accounts_receivable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source_type = 'sales'
     and new.source_session_id is not null
     and exists (
       select 1
       from public.sales_records s
       where s.session_id = new.source_session_id
         and public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,''))
           = public.canonical_importer_code(new.importer_code)
         and s.revenue_recognition_mode = 'customs_only'
     ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_customs_only_accounts_receivable
  on public.accounts_receivable;
create trigger trg_guard_customs_only_accounts_receivable
before insert or update of source_type, source_session_id, importer_code
on public.accounts_receivable
for each row execute function public.guard_customs_only_accounts_receivable();

create or replace function public.finalize_export_revenue_route(
  p_session_id uuid,
  p_work_date date,
  p_finalized_at timestamptz,
  p_shipping_fee numeric,
  p_shipping_fees jsonb
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
    and coalesce(importer_code,importer_id,'') <> '';

  update public.sales_records
  set work_date = p_work_date,
      finalized_at = coalesce(p_finalized_at,now()),
      finalized_by = auth.uid(),
      domestic_sale_id = null,
      revenue_recognition_mode = 'direct_export'
  where session_id = p_session_id;

  for route_group in
    select
      public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,'')) as importer_code,
      min(coalesce(s.importer_code,s.importer_id,'')) as source_importer_code
    from public.sales_records s
    where s.session_id = p_session_id
      and coalesce(s.importer_code,s.importer_id,'') <> ''
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

  update public.work_sessions
  set locked = true,
      work_date = p_work_date,
      finalized_at = coalesce(p_finalized_at,now()),
      finalized_by = auth.uid(),
      status = 'closed',
      shipping_fee = round(coalesce(p_shipping_fee,0),2),
      shipping_fees = coalesce(p_shipping_fees,'{}'::jsonb)
  where id = p_session_id
    and not locked
  returning * into session_row;

  if not found then
    raise exception '別の端末で先に売上確定された可能性があります。最新状態を再読込してください。'
      using errcode = '55000';
  end if;

  return jsonb_build_object(
    'session',to_jsonb(session_row),
    'direct_importers',to_jsonb(direct_importers),
    'domestic_sales',domestic_sales
  );
end;
$$;

revoke all on function public.guard_customs_only_accounts_receivable() from public;
revoke all on function public.finalize_export_revenue_route(uuid,date,timestamptz,numeric,jsonb) from public;
grant execute on function public.finalize_export_revenue_route(uuid,date,timestamptz,numeric,jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
