-- Purchase prices used by purchase entry and gross-profit analysis.
-- Run after order-entry-beta-migration.sql.

begin;

alter table public.product_master
  add column if not exists purchase_unit_price numeric,
  add column if not exists purchase_price_unit text not null default 'Kg';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_master'::regclass
      and conname = 'product_master_purchase_unit_price_check'
  ) then
    alter table public.product_master
      add constraint product_master_purchase_unit_price_check
      check (purchase_unit_price is null or purchase_unit_price >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_master'::regclass
      and conname = 'product_master_purchase_price_unit_check'
  ) then
    alter table public.product_master
      add constraint product_master_purchase_price_unit_check
      check (purchase_price_unit in ('Kg','pkt','PC','CS'));
  end if;
end $$;

create table if not exists public.product_supplier_prices (
  product_id text not null references public.product_master(product_id) on delete cascade,
  supplier_code text not null references public.supplier_master(supplier_code) on delete cascade,
  unit_price numeric not null check (unit_price >= 0),
  price_unit text not null default 'Kg' check (price_unit in ('Kg','pkt','PC','CS')),
  source_filename text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, supplier_code)
);

create index if not exists idx_product_supplier_prices_supplier
  on public.product_supplier_prices(supplier_code, product_id);

drop trigger if exists trg_product_supplier_prices_updated_at on public.product_supplier_prices;
create trigger trg_product_supplier_prices_updated_at
before update on public.product_supplier_prices
for each row execute function public.set_updated_at();

do $$
begin
  if to_regprocedure('public.log_master_change()') is not null then
    drop trigger if exists trg_product_supplier_prices_change_log on public.product_supplier_prices;
    create trigger trg_product_supplier_prices_change_log
    after insert or update or delete on public.product_supplier_prices
    for each row execute function public.log_master_change();
  end if;
end $$;

alter table public.product_supplier_prices enable row level security;

drop policy if exists "authenticated can read product supplier prices" on public.product_supplier_prices;
drop policy if exists "master admins can insert product supplier prices" on public.product_supplier_prices;
drop policy if exists "master admins can update product supplier prices" on public.product_supplier_prices;
drop policy if exists "master admins can delete product supplier prices" on public.product_supplier_prices;

create policy "authenticated can read product supplier prices"
  on public.product_supplier_prices for select to authenticated using (true);
create policy "master admins can insert product supplier prices"
  on public.product_supplier_prices for insert to authenticated with check (public.is_master_admin());
create policy "master admins can update product supplier prices"
  on public.product_supplier_prices for update to authenticated
  using (public.is_master_admin()) with check (public.is_master_admin());
create policy "master admins can delete product supplier prices"
  on public.product_supplier_prices for delete to authenticated using (public.is_master_admin());

do $$
begin
  if to_regprocedure('public.is_internal_user()') is not null then
    drop policy if exists internal_access_guard on public.product_supplier_prices;
    create policy internal_access_guard
      on public.product_supplier_prices as restrictive for all to authenticated
      using (public.is_internal_user()) with check (public.is_internal_user());
  end if;
end $$;

revoke all on public.product_supplier_prices from anon;
grant select, insert, update, delete on public.product_supplier_prices to authenticated;

notify pgrst, 'reload schema';

commit;
