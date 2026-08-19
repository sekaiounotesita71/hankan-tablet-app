-- Shared LINE expression dictionary for order reconciliation.
-- Run this file once in Supabase SQL Editor after site-partner-purchase-migration.sql.

begin;

create extension if not exists pgcrypto;

create table if not exists public.line_order_dictionary (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null default 'customer'
    check (scope_type in ('customer', 'common')),
  scope_key text not null,
  importer_code text not null default '',
  customer_code text,
  customer_name_snapshot text,
  expression_key text not null,
  source_expression text not null,
  product_code text not null,
  product_name_snapshot text,
  usage_count integer not null default 1 check (usage_count >= 0),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scope_type, scope_key, importer_code, expression_key)
);

create index if not exists idx_line_order_dictionary_lookup
  on public.line_order_dictionary (active, importer_code, scope_key, expression_key);

alter table public.line_order_dictionary enable row level security;

drop policy if exists line_order_dictionary_internal_select on public.line_order_dictionary;
create policy line_order_dictionary_internal_select
  on public.line_order_dictionary
  for select
  to authenticated
  using (public.is_internal_user());

drop policy if exists line_order_dictionary_internal_insert on public.line_order_dictionary;
create policy line_order_dictionary_internal_insert
  on public.line_order_dictionary
  for insert
  to authenticated
  with check (public.is_internal_user());

drop policy if exists line_order_dictionary_internal_update on public.line_order_dictionary;
create policy line_order_dictionary_internal_update
  on public.line_order_dictionary
  for update
  to authenticated
  using (public.is_internal_user())
  with check (public.is_internal_user());

drop policy if exists line_order_dictionary_internal_delete on public.line_order_dictionary;
create policy line_order_dictionary_internal_delete
  on public.line_order_dictionary
  for delete
  to authenticated
  using (public.is_internal_user());

grant select, insert, update, delete on public.line_order_dictionary to authenticated;

create or replace function public.upsert_line_order_dictionary(
  p_scope_type text,
  p_scope_key text,
  p_importer_code text,
  p_customer_code text,
  p_customer_name text,
  p_expression_key text,
  p_source_expression text,
  p_product_code text,
  p_product_name text
)
returns public.line_order_dictionary
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_scope_type text := case when p_scope_type = 'common' then 'common' else 'customer' end;
  v_scope_key text := case when p_scope_type = 'common' then '*' else nullif(btrim(coalesce(p_scope_key, '')), '') end;
  v_importer_code text := upper(btrim(coalesce(p_importer_code, '')));
  v_expression_key text := nullif(btrim(coalesce(p_expression_key, '')), '');
  v_product_code text := nullif(btrim(coalesce(p_product_code, '')), '');
  v_result public.line_order_dictionary;
begin
  if not public.is_internal_user() then
    raise exception 'internal user access required' using errcode = '42501';
  end if;
  if v_scope_key is null then
    raise exception 'scope key is required' using errcode = '22023';
  end if;
  if v_expression_key is null then
    raise exception 'expression key is required' using errcode = '22023';
  end if;
  if v_product_code is null then
    raise exception 'product code is required' using errcode = '22023';
  end if;

  insert into public.line_order_dictionary (
    scope_type,
    scope_key,
    importer_code,
    customer_code,
    customer_name_snapshot,
    expression_key,
    source_expression,
    product_code,
    product_name_snapshot,
    usage_count,
    active,
    created_by,
    updated_by
  )
  values (
    v_scope_type,
    v_scope_key,
    v_importer_code,
    nullif(btrim(coalesce(p_customer_code, '')), ''),
    nullif(btrim(coalesce(p_customer_name, '')), ''),
    v_expression_key,
    btrim(coalesce(p_source_expression, '')),
    v_product_code,
    nullif(btrim(coalesce(p_product_name, '')), ''),
    1,
    true,
    auth.uid(),
    auth.uid()
  )
  on conflict (scope_type, scope_key, importer_code, expression_key)
  do update set
    customer_code = excluded.customer_code,
    customer_name_snapshot = excluded.customer_name_snapshot,
    source_expression = excluded.source_expression,
    product_code = excluded.product_code,
    product_name_snapshot = excluded.product_name_snapshot,
    usage_count = case
      when public.line_order_dictionary.product_code = excluded.product_code
        then public.line_order_dictionary.usage_count + 1
      else 1
    end,
    active = true,
    updated_by = auth.uid(),
    updated_at = now()
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.upsert_line_order_dictionary(text,text,text,text,text,text,text,text,text) from public;
grant execute on function public.upsert_line_order_dictionary(text,text,text,text,text,text,text,text,text) to authenticated;

commit;
