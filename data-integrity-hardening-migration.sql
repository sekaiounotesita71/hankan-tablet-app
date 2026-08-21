-- Prevent anonymous writes, finalized-session deletion, and post-finalization sales inserts.
-- Run once in Supabase SQL Editor after the existing migrations.

alter table public.user_roles enable row level security;
revoke all on public.user_roles from anon;
grant select on public.user_roles to authenticated;

drop policy if exists "authenticated can read user roles" on public.user_roles;
create policy "authenticated can read user roles"
on public.user_roles for select to authenticated
using (true);

create or replace function public.is_master_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.user_roles
      where user_id = auth.uid() and role = 'admin'
    );
$$;

revoke all on function public.is_master_admin() from public;
grant execute on function public.is_master_admin() to authenticated;

do $$
declare
  table_name text;
  policy_row record;
begin
  foreach table_name in array array[
    'importer_master',
    'supplier_master',
    'product_master',
    'product_price_contracts',
    'product_supplier_prices',
    'customer_master'
  ]
  loop
    if to_regclass('public.' || table_name) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from anon', table_name);
    execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);

    for policy_row in
      select policyname
      from pg_policies
      where schemaname = 'public' and tablename = table_name
    loop
      execute format('drop policy if exists %I on public.%I', policy_row.policyname, table_name);
    end loop;

    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      'authenticated can read ' || table_name,
      table_name
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.is_master_admin())',
      'master admins can insert ' || table_name,
      table_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.is_master_admin()) with check (public.is_master_admin())',
      'master admins can update ' || table_name,
      table_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.is_master_admin())',
      'master admins can delete ' || table_name,
      table_name
    );
  end loop;
end $$;

do $$
declare
  table_name text;
  policy_row record;
begin
  foreach table_name in array array['order_entry_batches','order_entry_lines']
  loop
    if to_regclass('public.' || table_name) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from anon', table_name);
    execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);

    for policy_row in
      select policyname
      from pg_policies
      where schemaname = 'public' and tablename = table_name
    loop
      execute format('drop policy if exists %I on public.%I', policy_row.policyname, table_name);
    end loop;

    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      'authenticated can read ' || table_name,
      table_name
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (true)',
      'authenticated can insert ' || table_name,
      table_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (true) with check (true)',
      'authenticated can update ' || table_name,
      table_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (true)',
      'authenticated can delete ' || table_name,
      table_name
    );
  end loop;
end $$;

create or replace function public.guard_finalized_work_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.locked or old.status = 'closed'
      or exists (select 1 from public.sales_records where session_id = old.id)
    then
      raise exception 'Finalized work sessions cannot be deleted. Use the sales-correction workflow.';
    end if;
    return old;
  end if;

  if (
    old.locked
    or old.status = 'closed'
  ) and not public.is_master_admin() and (
    new.locked is distinct from old.locked
    or new.status is distinct from old.status
    or new.finalized_at is distinct from old.finalized_at
    or new.finalized_by is distinct from old.finalized_by
    or new.shipping_fee is distinct from old.shipping_fee
    or new.shipping_fees is distinct from old.shipping_fees
  ) then
    raise exception 'Finalized work-session fields can only be changed by an administrator.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_finalized_work_session on public.work_sessions;
create trigger trg_guard_finalized_work_session
before update or delete on public.work_sessions
for each row execute function public.guard_finalized_work_session();

create or replace function public.guard_finalized_work_child()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_session_id uuid;
  parent_locked boolean;
  parent_status text;
begin
  if tg_op = 'DELETE' then
    target_session_id := old.session_id;
  else
    target_session_id := new.session_id;
  end if;

  select locked, status
  into parent_locked, parent_status
  from public.work_sessions
  where id = target_session_id
  for update;

  if (
    coalesce(parent_locked,false)
    or parent_status = 'closed'
    or exists (select 1 from public.sales_records where session_id = target_session_id)
  ) and not public.is_master_admin() then
    raise exception 'Finalized work details can only be changed through an administrator correction.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_finalized_order_line on public.order_lines;
create trigger trg_guard_finalized_order_line
before insert or update or delete on public.order_lines
for each row execute function public.guard_finalized_work_child();

drop trigger if exists trg_guard_finalized_box on public.boxes;
create trigger trg_guard_finalized_box
before insert or update or delete on public.boxes
for each row execute function public.guard_finalized_work_child();

create or replace function public.guard_sales_record_parent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_locked boolean;
  target_session_id uuid;
begin
  if tg_op = 'DELETE' then
    target_session_id := old.session_id;
  else
    target_session_id := new.session_id;
  end if;

  select locked
  into parent_locked
  from public.work_sessions
  where id = target_session_id
  for update;

  if coalesce(parent_locked,false) and not public.is_master_admin() then
    raise exception 'Finalized sales can only be changed through an administrator correction.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_sales_record_parent on public.sales_records;
create trigger trg_guard_sales_record_parent
before insert or update or delete on public.sales_records
for each row execute function public.guard_sales_record_parent();

drop policy if exists "authenticated can insert sales records" on public.sales_records;
create policy "authenticated can insert sales records"
on public.sales_records for insert to authenticated
with check (
  public.is_master_admin()
  or exists (
    select 1
    from public.work_sessions session
    where session.id = sales_records.session_id
      and not coalesce(session.locked,false)
      and session.status <> 'closed'
  )
);

alter table public.order_entry_lines
  drop constraint if exists order_entry_lines_positive_line_no;
alter table public.order_entry_lines
  add constraint order_entry_lines_positive_line_no
  check (line_no > 0) not valid;

alter table public.order_lines
  drop constraint if exists order_lines_positive_source_row_no;
alter table public.order_lines
  add constraint order_lines_positive_source_row_no
  check (source_row_no > 0) not valid;

alter table public.sales_records
  drop constraint if exists sales_records_positive_source_row_no;
alter table public.sales_records
  add constraint sales_records_positive_source_row_no
  check (source_row_no > 0) not valid;

notify pgrst, 'reload schema';
