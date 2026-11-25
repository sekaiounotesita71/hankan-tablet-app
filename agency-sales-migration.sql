-- Read-only projection for the sales agency. Staff and browser roles get no new privileges.
begin;

drop function if exists public.agency_sales_07(date, date, integer);
create or replace function public.agency_sales_07(
  p_from date, p_to date, p_page integer,
  p_product text default '', p_customer text default '', p_site text default ''
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  product_search text := lower(btrim(coalesce(p_product, '')));
  customer_search text := lower(btrim(coalesce(p_customer, '')));
  site_filter text := coalesce(p_site, '');
begin
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
     or p_to < p_from or p_to - p_from > 366 or p_page is null or p_page < 1 or p_page > 100000 then
    raise exception 'Invalid sales period or page' using errcode = '22023';
  end if;
  if length(product_search) > 120 or length(customer_search) > 120 or site_filter not in ('', 'OSA', 'TYO') then
    raise exception 'Invalid sales search' using errcode = '22023';
  end if;

  return (
    with confirmed_sessions as materialized (
      select w.id, w.work_date, w.site_code, w.shipping_fees
      from public.work_sessions w
      where (w.locked or '07' = any(w.finalized_importer_codes))
        and not ('07' = any(w.reopened_importer_codes))
    ), current_sales as materialized (
      select s.id, s.session_id, coalesce(s.work_date, w.work_date) as sale_date,
             coalesce(s.site_code, w.site_code) as site_code,
             s.store_name as customer_name, s.product_id as product_code, s.product_name, s.input_qty as qty,
             s.input_unit as unit, s.unit_price, s.amount
      from public.sales_records s join confirmed_sessions w on w.id = s.session_id
      where btrim(s.importer_code) = '07'
        and coalesce(s.revenue_recognition_mode, 'direct_export') = 'direct_export'
        and not s.is_stockout
        and coalesce(s.work_date, w.work_date) between p_from and p_to
    ), visible_sales as (
      select 'sale'::text as kind, s.id, s.sale_date, s.site_code,
             s.customer_name, s.product_code, s.product_name, s.qty, s.unit, s.unit_price, s.amount
      from current_sales s
      union all
      select 'historical', h.id, (h.finalized_at at time zone 'Asia/Tokyo')::date, null,
             h.store_name, h.product_id, h.product_name, h.input_qty, h.input_unit, h.unit_price, h.amount
      from public.historical_sales_records h
      where btrim(h.importer_code) = '07' and not h.is_stockout
        and h.finalized_at >= (p_from::timestamp at time zone 'Asia/Tokyo')
        and h.finalized_at < ((p_to + 1)::timestamp at time zone 'Asia/Tokyo')
      union all
      select 'domestic', l.id, d.sale_date, w.site_code,
             d.customer_name_snapshot, l.product_code, l.product_name_snapshot,
             l.quantity, l.unit, l.unit_price_jpy, l.net_amount_jpy
      from public.domestic_sales d
      join public.domestic_sale_lines l on l.sale_id = d.id
      left join public.work_sessions w on w.id = d.source_session_id
      where d.source_type = 'export_intermediary' and btrim(d.source_importer_code) = '07'
        and d.status = 'confirmed' and d.sale_date between p_from and p_to
        and (w.id is null or not ('07' = any(w.reopened_importer_codes)))
      union all
      select case when p.entry_type = 'shipping_adjustment' then 'freight_adjustment' else 'adjustment' end,
             p.id, a.sale_date, null, p.customer_name_snapshot, p.product_code, p.product_name_snapshot,
             p.qty, p.unit, p.unit_price,
             case when p.entry_type in ('credit_note', 'discount') then -abs(p.amount) else p.amount end
      from public.pending_entries p
      cross join lateral (
        select coalesce((to_jsonb(p)->>'applied_work_date')::date, p.planned_date, p.entry_date) as sale_date
      ) a
      where btrim(p.importer_code) = '07' and p.status = 'applied'
        and nullif(btrim(p.applied_invoice_no), '') is not null
        and p.entry_type in ('credit_note', 'discount', 'extra_charge', 'shipping_adjustment', 'correction')
        and a.sale_date between p_from and p_to
      union all
      select 'freight', w.id, w.work_date, w.site_code, null, null, null, null, null, null,
             fee.amount
      from confirmed_sessions w
      cross join lateral (
        select case when (w.shipping_fees->>'07') ~ '^[0-9]+(\.[0-9]+)?$'
                    then (w.shipping_fees->>'07')::numeric end as amount
      ) fee
      where w.work_date between p_from and p_to
        and fee.amount <> 0
        and exists (select 1 from current_sales s where s.session_id = w.id)
    ), filtered_sales as materialized (
      select * from visible_sales v
      where (site_filter = '' or v.site_code = site_filter)
        and (product_search = '' or strpos(lower(coalesce(v.product_name, '')), product_search) > 0
             or strpos(lower(coalesce(v.product_code, '')), product_search) > 0)
        and (customer_search = '' or strpos(lower(coalesce(v.customer_name, '')), customer_search) > 0)
        and ((product_search = '' and customer_search = '') or v.kind not in ('freight', 'freight_adjustment'))
    ), page_rows as (
      select kind, sale_date, site_code, customer_name, product_code, product_name, qty, unit, unit_price, amount
      from filtered_sales
      order by sale_date desc, kind, id
      limit 100 offset ((p_page - 1) * 100)
    )
    select jsonb_build_object(
      'count', (select count(*) from filtered_sales),
      'missingAmountCount', (select count(*) from filtered_sales where amount is null),
      'netSales', (select coalesce(sum(amount),0) from filtered_sales where kind not in ('freight','freight_adjustment')),
      'freight', (select coalesce(sum(amount),0) from filtered_sales where kind in ('freight','freight_adjustment')),
      'rows', (select coalesce(jsonb_agg(to_jsonb(page_rows)), '[]'::jsonb) from page_rows)
    )
  );
end;
$$;

revoke all on function public.agency_sales_07(date, date, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.agency_sales_07(date, date, integer, text, text, text) to service_role;
notify pgrst, 'reload schema';
commit;
