-- Invoice output profiles and destination-specific declaration rules.
-- Run once in Supabase SQL Editor. Re-running is safe.

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

create table if not exists public.invoice_profiles (
  importer_code text primary key,
  profile_name text,
  shipper_name text,
  shipper_address text,
  shipper_phone text,
  notify_party_name text,
  notify_party_address text,
  notify_party_phone text,
  consignee_name text,
  consignee_address text,
  consignee_phone text,
  departure_port text,
  destination_port text,
  transport_details text,
  carrier text,
  via text,
  trade_terms text,
  currency text not null default 'JPY',
  payment_details text,
  remarks text not null default 'Commercial value',
  marks_and_numbers text not null default 'Listed in the table',
  invoice_sequence text,
  include_shipping_fee boolean not null default true,
  is_active boolean not null default true,
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.invoice_product_rules (
  id uuid primary key default gen_random_uuid(),
  importer_code text not null,
  product_id text not null,
  match_origin text not null default '',
  match_product_name text not null default '',
  invoice_japanese_name text,
  invoice_english_name text,
  invoice_origin text,
  packing text,
  hs_code text,
  notes text,
  priority integer not null default 100,
  is_active boolean not null default true,
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (importer_code, product_id, match_origin, match_product_name)
);

create table if not exists public.invoice_export_logs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.work_sessions(id) on delete set null,
  importer_code text not null,
  invoice_no text,
  work_date date,
  row_count integer not null default 0,
  subtotal numeric not null default 0,
  shipping_amount numeric not null default 0,
  total_amount numeric not null default 0,
  validation_summary jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_invoice_product_rules_lookup
  on public.invoice_product_rules(importer_code, product_id, priority, updated_at desc)
  where is_active = true;

create index if not exists idx_invoice_export_logs_session
  on public.invoice_export_logs(session_id, importer_code, created_at desc);

drop trigger if exists trg_invoice_profiles_updated_at on public.invoice_profiles;
create trigger trg_invoice_profiles_updated_at
before update on public.invoice_profiles
for each row execute function public.set_updated_at();

drop trigger if exists trg_invoice_product_rules_updated_at on public.invoice_product_rules;
create trigger trg_invoice_product_rules_updated_at
before update on public.invoice_product_rules
for each row execute function public.set_updated_at();

do $$
begin
  if to_regprocedure('public.log_business_audit_event()') is not null then
    execute 'drop trigger if exists trg_business_audit on public.invoice_profiles';
    execute 'create trigger trg_business_audit after insert or update or delete on public.invoice_profiles for each row execute function public.log_business_audit_event()';
    execute 'drop trigger if exists trg_business_audit on public.invoice_product_rules';
    execute 'create trigger trg_business_audit after insert or update or delete on public.invoice_product_rules for each row execute function public.log_business_audit_event()';
  end if;
end $$;

alter table public.invoice_profiles enable row level security;
alter table public.invoice_product_rules enable row level security;
alter table public.invoice_export_logs enable row level security;

drop policy if exists "authenticated can read invoice profiles" on public.invoice_profiles;
create policy "authenticated can read invoice profiles"
on public.invoice_profiles for select to authenticated using (public.is_internal_user());

drop policy if exists "master admins can insert invoice profiles" on public.invoice_profiles;
create policy "master admins can insert invoice profiles"
on public.invoice_profiles for insert to authenticated with check (public.is_master_admin());

drop policy if exists "master admins can update invoice profiles" on public.invoice_profiles;
create policy "master admins can update invoice profiles"
on public.invoice_profiles for update to authenticated using (public.is_master_admin()) with check (public.is_master_admin());

drop policy if exists "master admins can delete invoice profiles" on public.invoice_profiles;
create policy "master admins can delete invoice profiles"
on public.invoice_profiles for delete to authenticated using (public.is_master_admin());

drop policy if exists "authenticated can read invoice product rules" on public.invoice_product_rules;
create policy "authenticated can read invoice product rules"
on public.invoice_product_rules for select to authenticated using (public.is_internal_user());

drop policy if exists "master admins can insert invoice product rules" on public.invoice_product_rules;
create policy "master admins can insert invoice product rules"
on public.invoice_product_rules for insert to authenticated with check (public.is_master_admin());

drop policy if exists "master admins can update invoice product rules" on public.invoice_product_rules;
create policy "master admins can update invoice product rules"
on public.invoice_product_rules for update to authenticated using (public.is_master_admin()) with check (public.is_master_admin());

drop policy if exists "master admins can delete invoice product rules" on public.invoice_product_rules;
create policy "master admins can delete invoice product rules"
on public.invoice_product_rules for delete to authenticated using (public.is_master_admin());

drop policy if exists "admins can read invoice export logs" on public.invoice_export_logs;
create policy "admins can read invoice export logs"
on public.invoice_export_logs for select to authenticated using (public.is_master_admin());

drop policy if exists "authenticated can insert invoice export logs" on public.invoice_export_logs;
create policy "authenticated can insert invoice export logs"
on public.invoice_export_logs for insert to authenticated
with check (created_by = auth.uid() and public.is_internal_user());

notify pgrst, 'reload schema';
