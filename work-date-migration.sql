-- 作業日を売上日として保存し、実際の売上確定日時とは分けて管理します。
-- Supabase Dashboard > SQL Editor で実行してください。

alter table public.work_sessions
  add column if not exists work_date date;

alter table public.sales_records
  add column if not exists work_date date;

-- 作業名に含まれる日付を最優先で、既存作業の作業日を補完します。
update public.work_sessions
set work_date = coalesce(
  case
    when substring(name from '20[0-9]{2}-[0-9]{2}-[0-9]{2}') is not null
      then to_date(substring(name from '20[0-9]{2}-[0-9]{2}-[0-9]{2}'), 'YYYY-MM-DD')
    when substring(name from '20[0-9]{2}/[0-9]{2}/[0-9]{2}') is not null
      then to_date(substring(name from '20[0-9]{2}/[0-9]{2}/[0-9]{2}'), 'YYYY/MM/DD')
    when substring(name from '20[0-9]{6}') is not null
      then to_date(substring(name from '20[0-9]{6}'), 'YYYYMMDD')
    else null
  end,
  timezone('Asia/Tokyo', coalesce(finalized_at, created_at))::date
)
where work_date is null;

-- 売上明細は所属する作業の作業日を引き継ぎます。
update public.sales_records as sales
set work_date = coalesce(
  (
    select session.work_date
    from public.work_sessions as session
    where session.id = sales.session_id
  ),
  timezone('Asia/Tokyo', sales.finalized_at)::date
)
where sales.work_date is null;

create index if not exists idx_work_sessions_work_date
  on public.work_sessions(work_date desc);

create index if not exists idx_sales_records_work_date
  on public.sales_records(work_date desc, importer_code, store_name, product_id);

notify pgrst, 'reload schema';
