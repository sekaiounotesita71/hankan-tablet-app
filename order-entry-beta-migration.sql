-- Order entry beta schema.
-- Supabase SQL Editorで再実行してください。
-- 方針:
--   商品マスタ: public.product_master
--   商品別契約価格: public.product_price_contracts
--   得意先マスタ: public.customer_master
--   仕入先マスタ: public.supplier_master
--   輸入社マスタ: public.importer_master
-- product_master_unified / customer_master_unified は新規利用しません。

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

create table if not exists public.importer_master (
  importer_code text primary key,
  importer_name text not null,
  aliases text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.supplier_master (
  supplier_code text primary key,
  supplier_name text not null,
  aliases text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_master (
  product_id text primary key,
  product_name text,
  english_name text,
  scientific_name text,
  origin text,
  unit_price numeric,
  source_filename text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.product_master
  add column if not exists aliases text[] not null default '{}',
  add column if not exists default_supplier_code text,
  add column if not exists default_supplier_name text;

create table if not exists public.product_price_contracts (
  product_id text not null references public.product_master(product_id) on delete cascade,
  importer_code text not null,
  unit_price numeric not null,
  source_filename text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, importer_code)
);

create table if not exists public.customer_master (
  id uuid primary key default gen_random_uuid(),
  customer_code text,
  customer_name text not null,
  importer_code text,
  country_code text,
  alias_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.customer_master
  add column if not exists customer_code text,
  add column if not exists importer_code text,
  add column if not exists country_code text,
  add column if not exists alias_name text,
  add column if not exists active boolean not null default true;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.customer_master'::regclass
      and conname = 'customer_master_customer_code_key'
  ) then
    alter table public.customer_master
      add constraint customer_master_customer_code_key unique (customer_code);
  end if;
exception
  when unique_violation then
    raise notice 'customer_master.customer_code has duplicates. Fix duplicates before using customer_code upsert.';
end $$;

create table if not exists public.order_entry_batches (
  id uuid primary key default gen_random_uuid(),
  order_date date not null,
  ship_date date,
  importer_code text,
  importer_name_snapshot text,
  customer_code text,
  customer_name_snapshot text,
  status text not null default 'draft' check (status in ('draft','confirmed','cancelled')),
  source_type text not null default 'manual' check (source_type in ('manual','line','csv','system')),
  note text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_entry_lines (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.order_entry_batches(id) on delete cascade,
  line_no integer not null,
  product_code text,
  product_name_snapshot text not null,
  english_name_snapshot text,
  order_qty numeric(12,3),
  order_unit text,
  supplier_code text,
  supplier_name_snapshot text,
  purchase_note text,
  unit_price numeric,
  source_text text,
  match_confidence numeric(5,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(batch_id, line_no)
);

alter table public.order_entry_batches
  add column if not exists confirmed_at timestamptz;

alter table public.order_entry_lines
  add column if not exists unit_price numeric;

do $$
declare
  r record;
begin
  if to_regclass('public.order_entry_lines') is not null then
    for r in
      select conname
      from pg_constraint
      where conrelid = 'public.order_entry_lines'::regclass
        and contype = 'f'
        and confrelid in (
          coalesce(to_regclass('public.product_master_unified'), 'public.order_entry_lines'::regclass),
          'public.product_master'::regclass
        )
    loop
      execute format('alter table public.order_entry_lines drop constraint if exists %I', r.conname);
    end loop;
  end if;

  if to_regclass('public.order_entry_batches') is not null then
    for r in
      select conname
      from pg_constraint
      where conrelid = 'public.order_entry_batches'::regclass
        and contype = 'f'
        and confrelid = coalesce(to_regclass('public.customer_master_unified'), 'public.order_entry_batches'::regclass)
    loop
      execute format('alter table public.order_entry_batches drop constraint if exists %I', r.conname);
    end loop;
  end if;
end $$;

create index if not exists idx_order_entry_batches_order_date on public.order_entry_batches(order_date);
create index if not exists idx_order_entry_batches_ship_date on public.order_entry_batches(ship_date);
create index if not exists idx_order_entry_batches_importer on public.order_entry_batches(importer_code);
create index if not exists idx_order_entry_batches_customer on public.order_entry_batches(customer_code);
create index if not exists idx_order_entry_lines_product on public.order_entry_lines(product_code);
create index if not exists idx_order_entry_lines_supplier on public.order_entry_lines(supplier_code);
create index if not exists idx_product_master_updated_at on public.product_master(updated_at desc);
create index if not exists idx_product_price_contracts_importer on public.product_price_contracts(importer_code);
create index if not exists idx_customer_master_lookup on public.customer_master(importer_code, country_code, customer_name);

drop trigger if exists trg_importer_master_updated_at on public.importer_master;
create trigger trg_importer_master_updated_at
before update on public.importer_master
for each row execute function public.set_updated_at();

drop trigger if exists trg_supplier_master_updated_at on public.supplier_master;
create trigger trg_supplier_master_updated_at
before update on public.supplier_master
for each row execute function public.set_updated_at();

drop trigger if exists trg_product_master_updated_at on public.product_master;
create trigger trg_product_master_updated_at
before update on public.product_master
for each row execute function public.set_updated_at();

drop trigger if exists trg_product_price_contracts_updated_at on public.product_price_contracts;
create trigger trg_product_price_contracts_updated_at
before update on public.product_price_contracts
for each row execute function public.set_updated_at();

drop trigger if exists trg_customer_master_updated_at on public.customer_master;
create trigger trg_customer_master_updated_at
before update on public.customer_master
for each row execute function public.set_updated_at();

drop trigger if exists trg_order_entry_batches_updated_at on public.order_entry_batches;
create trigger trg_order_entry_batches_updated_at
before update on public.order_entry_batches
for each row execute function public.set_updated_at();

drop trigger if exists trg_order_entry_lines_updated_at on public.order_entry_lines;
create trigger trg_order_entry_lines_updated_at
before update on public.order_entry_lines
for each row execute function public.set_updated_at();

alter table public.importer_master enable row level security;
alter table public.supplier_master enable row level security;
alter table public.product_master enable row level security;
alter table public.product_price_contracts enable row level security;
alter table public.customer_master enable row level security;
alter table public.order_entry_batches enable row level security;
alter table public.order_entry_lines enable row level security;

drop policy if exists "anon all importer master" on public.importer_master;
drop policy if exists "anon all supplier master" on public.supplier_master;
drop policy if exists "anon all product master" on public.product_master;
drop policy if exists "anon all product price contracts" on public.product_price_contracts;
drop policy if exists "anon all customer master" on public.customer_master;
drop policy if exists "anon all order entry batches" on public.order_entry_batches;
drop policy if exists "anon all order entry lines" on public.order_entry_lines;

create policy "anon all importer master" on public.importer_master for all to anon using (true) with check (true);
create policy "anon all supplier master" on public.supplier_master for all to anon using (true) with check (true);
create policy "anon all product master" on public.product_master for all to anon using (true) with check (true);
create policy "anon all product price contracts" on public.product_price_contracts for all to anon using (true) with check (true);
create policy "anon all customer master" on public.customer_master for all to anon using (true) with check (true);
create policy "anon all order entry batches" on public.order_entry_batches for all to anon using (true) with check (true);
create policy "anon all order entry lines" on public.order_entry_lines for all to anon using (true) with check (true);

notify pgrst, 'reload schema';
