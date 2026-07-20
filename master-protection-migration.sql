-- マスタの意図しない上書きを防止し、全変更を監査ログへ記録します。
-- Supabase Dashboard > SQL Editor で1回実行してください。

create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_roles enable row level security;

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
    and (
      exists (
        select 1 from public.user_roles
        where user_id = auth.uid() and role = 'admin'
      )
      or not exists (
        select 1 from public.user_roles where role = 'admin'
      )
    );
$$;

revoke all on function public.is_master_admin() from public;
grant execute on function public.is_master_admin() to authenticated;

create table if not exists public.master_change_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  record_key text not null,
  operation text not null check (operation in ('INSERT','UPDATE','DELETE')),
  old_data jsonb,
  new_data jsonb,
  changed_by uuid,
  changed_at timestamptz not null default now()
);

create index if not exists idx_master_change_log_changed_at
  on public.master_change_log(changed_at desc);
create index if not exists idx_master_change_log_record
  on public.master_change_log(table_name, record_key, changed_at desc);

create or replace function public.log_master_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  payload jsonb;
  master_key text;
begin
  payload := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  master_key := coalesce(
    payload ->> 'product_id',
    payload ->> 'customer_code',
    payload ->> 'supplier_code',
    payload ->> 'importer_code',
    payload ->> 'id',
    '(unknown)'
  );

  if tg_table_name = 'product_price_contracts' then
    master_key := coalesce(payload ->> 'product_id','') || '|' || coalesce(payload ->> 'importer_code','');
  end if;

  insert into public.master_change_log (
    table_name, record_key, operation, old_data, new_data, changed_by
  ) values (
    tg_table_name,
    master_key,
    tg_op,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
    auth.uid()
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'importer_master',
    'supplier_master',
    'product_master',
    'product_price_contracts',
    'customer_master'
  ]
  loop
    if to_regclass('public.' || table_name) is not null then
      execute format('drop trigger if exists trg_%I_change_log on public.%I', table_name, table_name);
      execute format(
        'create trigger trg_%I_change_log after insert or update or delete on public.%I for each row execute function public.log_master_change()',
        table_name,
        table_name
      );
    end if;
  end loop;
end $$;

alter table public.master_change_log enable row level security;

drop policy if exists "master admins can read change log" on public.master_change_log;
create policy "master admins can read change log"
on public.master_change_log for select to authenticated
using (public.is_master_admin());

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
    'customer_master'
  ]
  loop
    if to_regclass('public.' || table_name) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', table_name);

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

notify pgrst, 'reload schema';

