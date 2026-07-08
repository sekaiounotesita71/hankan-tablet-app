-- 商品マスタのクラウド保存機能を既存環境へ追加します。
-- Supabase Dashboard > SQL Editor で1回だけ実行してください。

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.product_master (
  product_id text primary key,
  product_name text,
  english_name text,
  scientific_name text,
  origin text,
  unit_price numeric,
  source_filename text,
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_price_contracts (
  product_id text not null references public.product_master(product_id) on delete cascade,
  importer_code text not null,
  unit_price numeric not null,
  source_filename text,
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, importer_code)
);

create index if not exists idx_product_master_updated_at
  on public.product_master(updated_at desc);

create index if not exists idx_product_price_contracts_importer
  on public.product_price_contracts(importer_code);

drop trigger if exists trg_product_master_updated_at on public.product_master;
create trigger trg_product_master_updated_at
before update on public.product_master
for each row execute function public.set_updated_at();

drop trigger if exists trg_product_price_contracts_updated_at on public.product_price_contracts;
create trigger trg_product_price_contracts_updated_at
before update on public.product_price_contracts
for each row execute function public.set_updated_at();

alter table public.product_master enable row level security;
alter table public.product_price_contracts enable row level security;

drop policy if exists "authenticated can read product master" on public.product_master;
create policy "authenticated can read product master"
on public.product_master for select to authenticated using (true);

drop policy if exists "authenticated can insert product master" on public.product_master;
create policy "authenticated can insert product master"
on public.product_master for insert to authenticated with check (true);

drop policy if exists "authenticated can update product master" on public.product_master;
create policy "authenticated can update product master"
on public.product_master for update to authenticated using (true) with check (true);

drop policy if exists "authenticated can delete product master" on public.product_master;
create policy "authenticated can delete product master"
on public.product_master for delete to authenticated using (true);

drop policy if exists "authenticated can read product price contracts" on public.product_price_contracts;
create policy "authenticated can read product price contracts"
on public.product_price_contracts for select to authenticated using (true);

drop policy if exists "authenticated can insert product price contracts" on public.product_price_contracts;
create policy "authenticated can insert product price contracts"
on public.product_price_contracts for insert to authenticated with check (true);

drop policy if exists "authenticated can update product price contracts" on public.product_price_contracts;
create policy "authenticated can update product price contracts"
on public.product_price_contracts for update to authenticated using (true) with check (true);

drop policy if exists "authenticated can delete product price contracts" on public.product_price_contracts;
create policy "authenticated can delete product price contracts"
on public.product_price_contracts for delete to authenticated using (true);
