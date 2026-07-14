-- Historical sales import schema.
-- Supabase Dashboard > SQL Editor で1回実行してください。
-- 現場確定の sales_records とは分けて、過去売上だけを保存します。

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.historical_sales_records (
  id uuid primary key default gen_random_uuid(),
  finalized_at timestamptz not null,
  country_code text,
  importer_code text,
  customer_code text,
  store_name text,
  product_id text,
  product_name text,
  english_name text,
  origin text,
  input_qty numeric,
  input_unit text,
  net_weight numeric,
  box_no text,
  unit_price numeric,
  amount numeric,
  memo text,
  is_stockout boolean not null default false,
  source_filename text not null default 'historical-sales',
  source_row_no integer not null,
  imported_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_filename, source_row_no)
);

create index if not exists idx_historical_sales_records_lookup
  on public.historical_sales_records(finalized_at desc, importer_code, store_name, product_id);

create index if not exists idx_historical_sales_records_product
  on public.historical_sales_records(product_id);

drop trigger if exists trg_historical_sales_records_updated_at on public.historical_sales_records;
create trigger trg_historical_sales_records_updated_at
before update on public.historical_sales_records
for each row execute function public.set_updated_at();

alter table public.historical_sales_records enable row level security;

drop policy if exists "authenticated can read historical sales records" on public.historical_sales_records;
create policy "authenticated can read historical sales records"
on public.historical_sales_records for select to authenticated using (true);

drop policy if exists "authenticated can insert historical sales records" on public.historical_sales_records;
create policy "authenticated can insert historical sales records"
on public.historical_sales_records for insert to authenticated with check (true);

drop policy if exists "authenticated can update historical sales records" on public.historical_sales_records;
create policy "authenticated can update historical sales records"
on public.historical_sales_records for update to authenticated using (true) with check (true);

drop policy if exists "authenticated can delete historical sales records" on public.historical_sales_records;
create policy "authenticated can delete historical sales records"
on public.historical_sales_records for delete to authenticated using (true);

notify pgrst, 'reload schema';
