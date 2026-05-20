-- Hankan Tablet App - Supabase schema
-- Supabase Dashboard > SQL Editor に貼り付けて実行してください。

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

create table if not exists public.work_sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active', 'closed', 'archived')),
  source_order_filename text,
  source_master_filename text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_lines (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.work_sessions(id) on delete cascade,
  source_row_no integer not null,

  country_code text,
  importer_id text,
  importer_code text,
  store_name text not null default 'UNKNOWN_STORE',

  product_id text,
  product_name text,
  ordered_qty numeric,
  ordered_unit text,
  unit_price numeric,
  english_name text,
  scientific_name text,
  origin text,

  input_qty numeric,
  input_unit text,
  net_weight numeric,
  box_no text,
  memo text,
  is_stockout boolean not null default false,

  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (session_id, source_row_no)
);

create table if not exists public.boxes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.work_sessions(id) on delete cascade,
  importer_code text not null,
  box_no text not null,

  gross_weight numeric,
  dry_ice_enabled boolean not null default false,
  dry_ice_weight numeric,
  box_size text,

  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (session_id, importer_code, box_no)
);

create index if not exists idx_order_lines_session_country_store
  on public.order_lines(session_id, country_code, store_name);

create index if not exists idx_order_lines_session_box
  on public.order_lines(session_id, importer_code, box_no);

create index if not exists idx_boxes_session_importer
  on public.boxes(session_id, importer_code, box_no);

drop trigger if exists trg_work_sessions_updated_at on public.work_sessions;
create trigger trg_work_sessions_updated_at
before update on public.work_sessions
for each row execute function public.set_updated_at();

drop trigger if exists trg_order_lines_updated_at on public.order_lines;
create trigger trg_order_lines_updated_at
before update on public.order_lines
for each row execute function public.set_updated_at();

drop trigger if exists trg_boxes_updated_at on public.boxes;
create trigger trg_boxes_updated_at
before update on public.boxes
for each row execute function public.set_updated_at();

alter table public.work_sessions enable row level security;
alter table public.order_lines enable row level security;
alter table public.boxes enable row level security;

-- 初期運用向け:
-- ログイン済みユーザーは全作業データを読める・作れる・更新できる設定です。
-- 現場チーム以外を入れない運用なら、まずはこれで進められます。
-- 将来、拠点別・権限別に分ける場合は、ここをより細かいポリシーへ変更します。

drop policy if exists "authenticated can read work sessions" on public.work_sessions;
create policy "authenticated can read work sessions"
on public.work_sessions
for select
to authenticated
using (true);

drop policy if exists "authenticated can insert work sessions" on public.work_sessions;
create policy "authenticated can insert work sessions"
on public.work_sessions
for insert
to authenticated
with check (true);

drop policy if exists "authenticated can update work sessions" on public.work_sessions;
create policy "authenticated can update work sessions"
on public.work_sessions
for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated can read order lines" on public.order_lines;
create policy "authenticated can read order lines"
on public.order_lines
for select
to authenticated
using (true);

drop policy if exists "authenticated can insert order lines" on public.order_lines;
create policy "authenticated can insert order lines"
on public.order_lines
for insert
to authenticated
with check (true);

drop policy if exists "authenticated can update order lines" on public.order_lines;
create policy "authenticated can update order lines"
on public.order_lines
for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated can read boxes" on public.boxes;
create policy "authenticated can read boxes"
on public.boxes
for select
to authenticated
using (true);

drop policy if exists "authenticated can insert boxes" on public.boxes;
create policy "authenticated can insert boxes"
on public.boxes
for insert
to authenticated
with check (true);

drop policy if exists "authenticated can update boxes" on public.boxes;
create policy "authenticated can update boxes"
on public.boxes
for update
to authenticated
using (true)
with check (true);

-- Realtime対象に追加します。
-- すでに追加済みの場合でも止まりにくいように、重複エラーは無視します。
do $$
begin
  alter publication supabase_realtime add table public.work_sessions;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.order_lines;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.boxes;
exception when duplicate_object then null;
end $$;
