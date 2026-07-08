-- Customer master for correcting customer names from PDF/order imports.
-- Run in Supabase Dashboard > SQL Editor.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.customer_master (
  id uuid primary key default gen_random_uuid(),
  customer_code text,
  customer_name text not null,
  importer_code text,
  country_code text,
  alias_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(importer_code, customer_name)
);

create index if not exists idx_customer_master_lookup
on public.customer_master(importer_code, country_code, customer_name);

drop trigger if exists trg_customer_master_updated_at on public.customer_master;
create trigger trg_customer_master_updated_at
before update on public.customer_master
for each row execute function public.set_updated_at();

alter table public.customer_master enable row level security;

drop policy if exists "authenticated can read customer master" on public.customer_master;
create policy "authenticated can read customer master"
on public.customer_master for select to authenticated using (true);

drop policy if exists "authenticated can insert customer master" on public.customer_master;
create policy "authenticated can insert customer master"
on public.customer_master for insert to authenticated with check (true);

drop policy if exists "authenticated can update customer master" on public.customer_master;
create policy "authenticated can update customer master"
on public.customer_master for update to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
