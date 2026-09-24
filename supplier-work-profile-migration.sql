-- Shared supplier-facing work report headers. Existing business records are untouched.
begin;

create table if not exists public.supplier_work_profiles (
  site_code text not null default '' check (site_code in ('','OSA','TYO')),
  importer_code text not null default '' check (length(importer_code)<=40),
  supplier_code text not null default '' check (length(supplier_code)<=40),
  cargo_location text not null default '' check (length(cargo_location)<=400),
  cargo_cut_time text not null default '' check (length(cargo_cut_time)<=100),
  document_cut_time text not null default '' check (length(document_cut_time)<=100),
  document_method text not null default '' check (length(document_method)<=600),
  packing_note text not null default '' check (length(packing_note)<=1200),
  destination_name text not null default '' check (length(destination_name)<=200),
  contact text not null default '' check (length(contact)<=200),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (site_code, importer_code, supplier_code)
);

alter table public.supplier_work_profiles enable row level security;
revoke all on public.supplier_work_profiles from anon, authenticated;
grant select, insert, update, delete on public.supplier_work_profiles to authenticated;
grant all on public.supplier_work_profiles to service_role;

drop policy if exists work_profiles_read on public.supplier_work_profiles;
create policy work_profiles_read on public.supplier_work_profiles for select to authenticated
  using (public.is_internal_user());
drop policy if exists work_profiles_insert on public.supplier_work_profiles;
create policy work_profiles_insert on public.supplier_work_profiles for insert to authenticated
  with check (public.is_internal_user() and public.is_master_admin());
drop policy if exists work_profiles_update on public.supplier_work_profiles;
create policy work_profiles_update on public.supplier_work_profiles for update to authenticated
  using (public.is_internal_user() and public.is_master_admin())
  with check (public.is_internal_user() and public.is_master_admin());
drop policy if exists work_profiles_delete on public.supplier_work_profiles;
create policy work_profiles_delete on public.supplier_work_profiles for delete to authenticated
  using (public.is_internal_user() and public.is_master_admin());

create or replace function public.stamp_supplier_work_profile()
returns trigger language plpgsql set search_path=public as $$
begin
  new.updated_at=now();
  new.updated_by=auth.uid();
  return new;
end;
$$;
drop trigger if exists stamp_supplier_work_profile on public.supplier_work_profiles;
create trigger stamp_supplier_work_profile before insert or update on public.supplier_work_profiles
  for each row execute function public.stamp_supplier_work_profile();
do $$
begin
  if to_regprocedure('public.log_business_audit_event()') is not null then
    execute 'drop trigger if exists trg_business_audit on public.supplier_work_profiles';
    execute 'create trigger trg_business_audit after insert or update or delete on public.supplier_work_profiles for each row execute function public.log_business_audit_event()';
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
