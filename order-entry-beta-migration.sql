-- Order entry beta schema.
-- Run in Supabase SQL Editor when moving the beta from localStorage to shared DB.

create extension if not exists pgcrypto;

create table if not exists importer_master (
  importer_code text primary key,
  importer_name text not null,
  aliases text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists supplier_master (
  supplier_code text primary key,
  supplier_name text not null,
  aliases text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists customer_master_unified (
  customer_code text primary key,
  customer_name text not null,
  aliases text[] not null default '{}',
  default_importer_code text references importer_master(importer_code),
  default_importer_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists product_master_unified (
  product_code text primary key,
  product_name text not null,
  english_name text,
  aliases text[] not null default '{}',
  default_unit text,
  default_supplier_code text references supplier_master(supplier_code),
  default_supplier_name text,
  unit_price numeric,
  contract_prices jsonb not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists order_entry_batches (
  id uuid primary key default gen_random_uuid(),
  order_date date not null,
  ship_date date,
  importer_code text references importer_master(importer_code),
  importer_name_snapshot text,
  customer_code text references customer_master_unified(customer_code),
  customer_name_snapshot text,
  status text not null default 'draft' check (status in ('draft','confirmed','cancelled')),
  source_type text not null default 'manual' check (source_type in ('manual','line','csv','system')),
  note text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists order_entry_lines (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references order_entry_batches(id) on delete cascade,
  line_no integer not null,
  product_code text references product_master_unified(product_code),
  product_name_snapshot text not null,
  english_name_snapshot text,
  order_qty numeric(12,3),
  order_unit text,
  supplier_code text references supplier_master(supplier_code),
  supplier_name_snapshot text,
  purchase_note text,
  unit_price numeric,
  source_text text,
  match_confidence numeric(5,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(batch_id, line_no)
);

create index if not exists idx_order_entry_batches_order_date on order_entry_batches(order_date);
create index if not exists idx_order_entry_batches_ship_date on order_entry_batches(ship_date);
create index if not exists idx_order_entry_batches_importer on order_entry_batches(importer_code);
create index if not exists idx_order_entry_batches_customer on order_entry_batches(customer_code);
create index if not exists idx_order_entry_lines_product on order_entry_lines(product_code);
create index if not exists idx_order_entry_lines_supplier on order_entry_lines(supplier_code);

alter table customer_master_unified
  add column if not exists default_importer_name text;

alter table product_master_unified
  add column if not exists default_supplier_name text,
  add column if not exists unit_price numeric,
  add column if not exists contract_prices jsonb not null default '{}';

alter table order_entry_batches
  add column if not exists confirmed_at timestamptz;

alter table order_entry_lines
  add column if not exists unit_price numeric;

alter table importer_master enable row level security;
alter table supplier_master enable row level security;
alter table customer_master_unified enable row level security;
alter table product_master_unified enable row level security;
alter table order_entry_batches enable row level security;
alter table order_entry_lines enable row level security;

drop policy if exists "anon read importer master" on importer_master;
drop policy if exists "anon write importer master" on importer_master;
drop policy if exists "anon read supplier master" on supplier_master;
drop policy if exists "anon write supplier master" on supplier_master;
drop policy if exists "anon read customer master unified" on customer_master_unified;
drop policy if exists "anon write customer master unified" on customer_master_unified;
drop policy if exists "anon read product master unified" on product_master_unified;
drop policy if exists "anon write product master unified" on product_master_unified;
drop policy if exists "anon read order entry batches" on order_entry_batches;
drop policy if exists "anon write order entry batches" on order_entry_batches;
drop policy if exists "anon read order entry lines" on order_entry_lines;
drop policy if exists "anon write order entry lines" on order_entry_lines;

create policy "anon read importer master" on importer_master for select to anon using (true);
create policy "anon write importer master" on importer_master for all to anon using (true) with check (true);
create policy "anon read supplier master" on supplier_master for select to anon using (true);
create policy "anon write supplier master" on supplier_master for all to anon using (true) with check (true);
create policy "anon read customer master unified" on customer_master_unified for select to anon using (true);
create policy "anon write customer master unified" on customer_master_unified for all to anon using (true) with check (true);
create policy "anon read product master unified" on product_master_unified for select to anon using (true);
create policy "anon write product master unified" on product_master_unified for all to anon using (true) with check (true);
create policy "anon read order entry batches" on order_entry_batches for select to anon using (true);
create policy "anon write order entry batches" on order_entry_batches for all to anon using (true) with check (true);
create policy "anon read order entry lines" on order_entry_lines for select to anon using (true);
create policy "anon write order entry lines" on order_entry_lines for all to anon using (true) with check (true);

notify pgrst, 'reload schema';
