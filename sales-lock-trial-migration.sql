-- 売上確定ロックお試し機能を既存Supabase環境へ追加します。
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

alter table public.work_sessions
  add column if not exists locked boolean not null default false,
  add column if not exists finalized_at timestamptz,
  add column if not exists finalized_by uuid references auth.users(id),
  add column if not exists unlocked_at timestamptz,
  add column if not exists unlocked_by uuid references auth.users(id),
  add column if not exists unlock_reason text;

create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sales_records (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.work_sessions(id) on delete cascade,
  source_row_no integer not null,
  finalized_at timestamptz not null default now(),
  finalized_by uuid references auth.users(id),
  country_code text,
  importer_id text,
  importer_code text,
  store_name text,
  product_id text,
  product_name text,
  english_name text,
  scientific_name text,
  origin text,
  ordered_qty numeric,
  ordered_unit text,
  input_qty numeric,
  input_unit text,
  net_weight numeric,
  box_no text,
  gross_weight numeric,
  dry_ice_enabled boolean not null default false,
  dry_ice_weight numeric,
  box_size text,
  unit_price numeric,
  amount numeric,
  memo text,
  is_stockout boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(session_id, source_row_no)
);

create index if not exists idx_sales_records_session on public.sales_records(session_id);
create index if not exists idx_sales_records_lookup on public.sales_records(finalized_at desc, importer_code, store_name, product_id);

drop trigger if exists trg_user_roles_updated_at on public.user_roles;
create trigger trg_user_roles_updated_at
before update on public.user_roles
for each row execute function public.set_updated_at();

drop trigger if exists trg_sales_records_updated_at on public.sales_records;
create trigger trg_sales_records_updated_at
before update on public.sales_records
for each row execute function public.set_updated_at();

alter table public.user_roles enable row level security;
alter table public.sales_records enable row level security;

drop policy if exists "authenticated can read user roles" on public.user_roles;
create policy "authenticated can read user roles"
on public.user_roles for select to authenticated using (true);

drop policy if exists "authenticated can read sales records" on public.sales_records;
create policy "authenticated can read sales records"
on public.sales_records for select to authenticated using (true);

drop policy if exists "authenticated can insert sales records" on public.sales_records;
create policy "authenticated can insert sales records"
on public.sales_records for insert to authenticated with check (true);

drop policy if exists "authenticated can update sales records" on public.sales_records;
create policy "authenticated can update sales records"
on public.sales_records for update to authenticated using (true) with check (true);

drop policy if exists "authenticated can delete sales records" on public.sales_records;
create policy "authenticated can delete sales records"
on public.sales_records for delete to authenticated using (true);

