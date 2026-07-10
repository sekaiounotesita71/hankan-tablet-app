-- Pending entries schema.
-- 赤伝、訂正、追加請求、値引き、送料調整、先行受注を invoice 反映前の未処理伝票として管理します。
-- Supabase Dashboard > SQL Editor で実行してください。

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

create table if not exists public.pending_entries (
  id uuid primary key default gen_random_uuid(),
  entry_type text not null check (
    entry_type in (
      'advance_order',
      'credit_note',
      'correction',
      'extra_charge',
      'discount',
      'shipping_adjustment'
    )
  ),
  status text not null default 'pending' check (status in ('pending', 'applied', 'hold', 'cancelled')),
  entry_date date not null default current_date,
  planned_date date,
  importer_code text not null,
  importer_name_snapshot text,
  customer_code text,
  customer_name_snapshot text not null,
  product_code text,
  product_name_snapshot text,
  description text not null,
  qty numeric,
  unit text,
  unit_price numeric,
  amount numeric not null default 0,
  reason text,
  memo text,
  source_type text not null default 'manual' check (source_type in ('manual', 'line', 'csv', 'system')),
  source_ref text,
  applied_invoice_no text,
  applied_at timestamptz,
  applied_by uuid references auth.users(id),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_pending_entries_status on public.pending_entries(status);
create index if not exists idx_pending_entries_importer_status on public.pending_entries(importer_code, status, entry_date desc);
create index if not exists idx_pending_entries_customer on public.pending_entries(customer_code, customer_name_snapshot);
create index if not exists idx_pending_entries_applied_invoice on public.pending_entries(applied_invoice_no);

drop trigger if exists trg_pending_entries_updated_at on public.pending_entries;
create trigger trg_pending_entries_updated_at
before update on public.pending_entries
for each row execute function public.set_updated_at();

alter table public.pending_entries enable row level security;

drop policy if exists "authenticated can read pending entries" on public.pending_entries;
create policy "authenticated can read pending entries"
on public.pending_entries for select to authenticated using (true);

drop policy if exists "authenticated can insert pending entries" on public.pending_entries;
create policy "authenticated can insert pending entries"
on public.pending_entries for insert to authenticated with check (true);

drop policy if exists "authenticated can update pending entries" on public.pending_entries;
create policy "authenticated can update pending entries"
on public.pending_entries for update to authenticated using (true) with check (true);

drop policy if exists "authenticated can delete pending entries" on public.pending_entries;
create policy "authenticated can delete pending entries"
on public.pending_entries for delete to authenticated using (true);

notify pgrst, 'reload schema';

