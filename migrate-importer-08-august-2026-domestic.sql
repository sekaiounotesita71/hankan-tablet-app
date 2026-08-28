-- One-time production migration for importer 08 (VN), August 2026.
-- Converts already-finalized export revenue into domestic intermediary sales.

begin;

-- Keep a complete pre-migration snapshot. This function is executable only by postgres.
select public.run_scheduled_business_snapshot();

-- The rows belong to locked work sessions. The transaction holds the table lock
-- while this administrator-only one-time migration updates their revenue route.
do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgrelid = 'public.sales_records'::regclass
      and tgname = 'trg_guard_sales_record_parent'
      and not tgisinternal
  ) then
    execute 'alter table public.sales_records disable trigger trg_guard_sales_record_parent';
  end if;
end;
$$;

do $$
declare
  target_importer constant text := public.canonical_importer_code('08');
  target_from constant date := date '2026-08-01';
  target_to constant date := date '2026-08-31';
  expected_sessions constant integer := 3;
  expected_net constant numeric := 191238;
  target_customer public.domestic_customer_master%rowtype;
  session_row record;
  generated_sale_id uuid;
  generated_sale_no text;
  generated_source_key text;
  actor_id uuid;
  subtotal_8 numeric(18,2);
  tax_8 numeric(18,2);
  total_net numeric(18,2);
  total_tax numeric(18,2);
  total_gross numeric(18,2);
  payment_due date;
  target_session_count integer;
  target_line_count integer;
  inserted_line_count integer;
  old_receivable_count integer;
  target_net numeric;
  old_receivable_net numeric;
  blocked_count integer;
begin
  if not exists (
    select 1
    from public.importer_master m
    where public.canonical_importer_code(m.importer_code) = target_importer
      and m.is_active
      and m.revenue_route = 'domestic_intermediary'
      and m.domestic_customer_code = '123'
  ) then
    raise exception 'Importer 08 is not configured for domestic customer 123.';
  end if;

  select * into target_customer
  from public.domestic_customer_master
  where customer_code = '123' and active
  for share;

  if not found then
    raise exception 'Active domestic customer 123 was not found.';
  end if;

  select
    count(distinct s.session_id),
    count(*),
    round(sum(case when coalesce(s.is_stockout,false) then 0 else coalesce(s.amount,s.input_qty*s.unit_price,0) end),0)
  into target_session_count,target_line_count,target_net
  from public.sales_records s
  where public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,'')) = target_importer
    and coalesce(s.work_date,s.finalized_at::date) between target_from and target_to;

  if target_session_count <> expected_sessions or target_net <> expected_net then
    raise exception 'Target changed: sessions %, lines %, net %.',target_session_count,target_line_count,target_net;
  end if;

  select count(*) into blocked_count
  from public.sales_records s
  where public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,'')) = target_importer
    and coalesce(s.work_date,s.finalized_at::date) between target_from and target_to
    and (s.revenue_recognition_mode <> 'direct_export' or s.domestic_sale_id is not null);

  if blocked_count <> 0 then
    raise exception 'Some target sales are already converted (% rows).',blocked_count;
  end if;

  select count(*),round(sum(r.net_sales_jpy),0)
  into old_receivable_count,old_receivable_net
  from public.accounts_receivable r
  where r.source_type = 'sales'
    and public.canonical_importer_code(r.importer_code) = target_importer
    and r.invoice_date between target_from and target_to;

  if old_receivable_count <> expected_sessions or old_receivable_net <> expected_net then
    raise exception 'Export receivables changed: rows %, net %.',old_receivable_count,old_receivable_net;
  end if;

  select count(*) into blocked_count
  from public.accounts_receivable r
  where r.source_type = 'sales'
    and public.canonical_importer_code(r.importer_code) = target_importer
    and r.invoice_date between target_from and target_to
    and (
      r.closing_id is not null
      or r.shipping_amount_jpy <> 0
      or r.adjustment_amount_jpy <> 0
      or exists (select 1 from public.accounts_receivable_payments p where p.receivable_id = r.id)
    );

  if blocked_count <> 0 then
    raise exception 'A target receivable is closed, paid, or adjusted (% rows).',blocked_count;
  end if;

  if exists (
    select 1
    from public.domestic_sales d
    where d.source_type = 'export_intermediary'
      and public.canonical_importer_code(coalesce(d.source_importer_code,'')) = target_importer
      and d.sale_date between target_from and target_to
  ) then
    raise exception 'Domestic intermediary sales already exist for importer 08 in August.';
  end if;

  for session_row in
    select
      w.id,
      w.name,
      min(coalesce(s.work_date,s.finalized_at::date)) as work_date,
      min(s.finalized_at) as finalized_at,
      min(s.finalized_by::text)::uuid as finalized_by
    from public.sales_records s
    join public.work_sessions w on w.id = s.session_id
    where public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,'')) = target_importer
      and coalesce(s.work_date,s.finalized_at::date) between target_from and target_to
    group by w.id,w.name
    order by min(coalesce(s.work_date,s.finalized_at::date)),w.id
  loop
    actor_id := session_row.finalized_by;
    generated_sale_id := gen_random_uuid();
    generated_source_key := 'export-intermediary:' || session_row.id::text || ':' || target_importer;
    generated_sale_no := 'DOM-' || to_char(session_row.work_date,'YYYYMMDD') || '-'
      || lpad(nextval('public.domestic_sale_no_seq')::text,6,'0');

    insert into public.domestic_sales (
      id,sale_no,sale_date,customer_code,customer_name_snapshot,status,
      shipping_amount_jpy,memo,confirmed_by,confirmed_at,
      source_type,source_session_id,source_importer_code,source_key
    ) values (
      generated_sale_id,generated_sale_no,session_row.work_date,target_customer.customer_code,
      target_customer.customer_name,'confirmed',0,
      '輸出作業 ' || coalesce(session_row.name,session_row.id::text) || ' / 輸入社 08 / 2026年8月経路変更',
      actor_id,coalesce(session_row.finalized_at,now()),
      'export_intermediary',session_row.id,target_importer,generated_source_key
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
      greatest(round(coalesce(s.amount,s.input_qty*s.unit_price,0),0),0),
      concat_ws(' / ',nullif(btrim(s.memo),''),nullif('輸出先: '||btrim(coalesce(s.store_name,'')),'輸出先: ')),
      s.id
    from public.sales_records s
    where s.session_id = session_row.id
      and public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,'')) = target_importer
      and not coalesce(s.is_stockout,false)
      and coalesce(s.input_qty,0) > 0
    order by s.source_row_no;

    get diagnostics inserted_line_count = row_count;
    if inserted_line_count = 0 then
      raise exception 'No billable lines for session %.',session_row.id;
    end if;

    select coalesce(sum(net_amount_jpy),0)
    into subtotal_8
    from public.domestic_sale_lines
    where sale_id = generated_sale_id and tax_rate = 8;

    tax_8 := floor(subtotal_8 * 0.08);
    total_net := subtotal_8;
    total_tax := tax_8;
    total_gross := total_net + total_tax;
    payment_due := public.domestic_receivable_due_date(
      session_row.work_date,target_customer.closing_day,
      target_customer.payment_month_offset,target_customer.payment_day
    );

    update public.domestic_sales
    set product_subtotal_8_jpy = subtotal_8,
        product_subtotal_10_jpy = 0,
        total_net_jpy = total_net,
        tax_8_jpy = tax_8,
        tax_10_jpy = 0,
        tax_total_jpy = total_tax,
        total_amount_jpy = total_gross
    where id = generated_sale_id;

    insert into public.domestic_receivables (
      source_key,source_type,sale_id,customer_code,customer_name_snapshot,
      invoice_date,due_date,amount_jpy,paid_amount_jpy,balance_jpy,status,memo,created_by,updated_by
    ) values (
      'sale:'||generated_sale_id::text,'sale',generated_sale_id,target_customer.customer_code,
      target_customer.customer_name,session_row.work_date,payment_due,total_gross,0,total_gross,
      case when total_gross=0 then 'paid' else 'unpaid' end,
      '輸出作業から自動作成 / 08 / 2026年8月経路変更',actor_id,actor_id
    );

    update public.sales_records s
    set revenue_recognition_mode = 'customs_only',
        domestic_sale_id = generated_sale_id
    where s.session_id = session_row.id
      and public.canonical_importer_code(coalesce(s.importer_code,s.importer_id,'')) = target_importer;

    delete from public.accounts_receivable r
    where r.source_type = 'sales'
      and r.source_session_id = session_row.id
      and public.canonical_importer_code(r.importer_code) = target_importer
      and r.closing_id is null
      and not exists (select 1 from public.accounts_receivable_payments p where p.receivable_id = r.id);

    if not found then
      raise exception 'Export receivable was not removed for session %.',session_row.id;
    end if;
  end loop;
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgrelid = 'public.sales_records'::regclass
      and tgname = 'trg_guard_sales_record_parent'
      and not tgisinternal
  ) then
    execute 'alter table public.sales_records enable trigger trg_guard_sales_record_parent';
  end if;
end;
$$;

commit;

-- Post-migration verification. Expected: 3 domestic sales / 3 billable lines / net 191238.
with target_sales as (
  select id,total_amount_jpy
  from public.domestic_sales
  where source_type = 'export_intermediary'
    and public.canonical_importer_code(source_importer_code) = public.canonical_importer_code('08')
    and sale_date between date '2026-08-01' and date '2026-08-31'
), target_lines as (
  select count(*) as line_count,round(sum(net_amount_jpy),0) as net_amount
  from public.domestic_sale_lines
  where sale_id in (select id from target_sales)
), target_receivables as (
  select count(*) as receivable_count,round(sum(balance_jpy),0) as balance
  from public.domestic_receivables
  where sale_id in (select id from target_sales)
)
select
  (select count(*) from target_sales) as domestic_sales,
  (select line_count from target_lines) as domestic_lines,
  (select net_amount from target_lines) as domestic_net,
  (select round(sum(total_amount_jpy),0) from target_sales) as domestic_gross,
  (select receivable_count from target_receivables) as domestic_receivables,
  (select balance from target_receivables) as receivable_balance;

select
  revenue_recognition_mode,
  count(*) as lines,
  count(distinct domestic_sale_id) as domestic_sales,
  round(sum(case when coalesce(is_stockout,false) then 0 else amount end),0) as net_amount
from public.sales_records
where public.canonical_importer_code(coalesce(importer_code,importer_id,'')) = public.canonical_importer_code('08')
  and coalesce(work_date,finalized_at::date) between date '2026-08-01' and date '2026-08-31'
group by revenue_recognition_mode;
