-- 売掛運用の開始日を固定し、開始日前の売上を売掛残高から除外します。
-- 運用開始日: 2026-08-01 / 初期残高基準日: 2026-07-31

begin;

create table if not exists public.accounts_receivable_settings (
  singleton boolean primary key default true check (singleton),
  operation_start_date date not null,
  opening_balance_as_of date not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.accounts_receivable_settings enable row level security;

drop policy if exists "authenticated can read receivable settings"
  on public.accounts_receivable_settings;
create policy "authenticated can read receivable settings"
on public.accounts_receivable_settings for select to authenticated
using (true);

drop policy if exists "admins can insert receivable settings"
  on public.accounts_receivable_settings;
create policy "admins can insert receivable settings"
on public.accounts_receivable_settings for insert to authenticated
with check (public.is_master_admin());

drop policy if exists "admins can update receivable settings"
  on public.accounts_receivable_settings;
create policy "admins can update receivable settings"
on public.accounts_receivable_settings for update to authenticated
using (public.is_master_admin())
with check (public.is_master_admin());

revoke insert, update, delete on public.accounts_receivable_settings from anon;
grant select on public.accounts_receivable_settings to authenticated;
grant insert, update on public.accounts_receivable_settings to authenticated;

insert into public.accounts_receivable_settings (
  singleton,
  operation_start_date,
  opening_balance_as_of,
  updated_by,
  updated_at
)
values (true, date '2026-08-01', date '2026-07-31', auth.uid(), now())
on conflict (singleton) do update set
  operation_start_date = excluded.operation_start_date,
  opening_balance_as_of = excluded.opening_balance_as_of,
  updated_by = auth.uid(),
  updated_at = now();

create table if not exists public.accounts_receivable_cutover_log (
  id bigint generated always as identity primary key,
  cutover_key text not null,
  receivable_id uuid not null,
  row_data jsonb not null,
  archived_at timestamptz not null default now(),
  archived_by uuid references auth.users(id) on delete set null,
  unique (cutover_key, receivable_id)
);

alter table public.accounts_receivable_cutover_log enable row level security;

drop policy if exists "admins can read receivable cutover log"
  on public.accounts_receivable_cutover_log;
create policy "admins can read receivable cutover log"
on public.accounts_receivable_cutover_log for select to authenticated
using (public.is_master_admin());

revoke insert, update, delete on public.accounts_receivable_cutover_log from authenticated;
grant select on public.accounts_receivable_cutover_log to authenticated;

do $$
begin
  if exists (
    select 1
    from public.accounts_receivable r
    where r.source_type <> 'opening'
      and r.invoice_date < date '2026-08-01'
      and (
        r.closing_id is not null
        or exists (
          select 1
          from public.accounts_receivable_payments p
          where p.receivable_id = r.id
        )
      )
  ) then
    raise exception '運用開始日前の売掛に締めまたは入金があります。自動除外を中止しました。';
  end if;
end;
$$;

insert into public.accounts_receivable_cutover_log (
  cutover_key,
  receivable_id,
  row_data,
  archived_by
)
select
  '2026-08-01-operation-start',
  r.id,
  to_jsonb(r),
  auth.uid()
from public.accounts_receivable r
where r.source_type <> 'opening'
  and r.invoice_date < date '2026-08-01'
on conflict (cutover_key, receivable_id) do nothing;

delete from public.accounts_receivable r
where r.source_type <> 'opening'
  and r.invoice_date < date '2026-08-01'
  and r.closing_id is null
  and not exists (
    select 1
    from public.accounts_receivable_payments p
    where p.receivable_id = r.id
  );

create or replace function public.remove_pre_cutover_receivable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  operation_start date;
begin
  select s.operation_start_date
    into operation_start
  from public.accounts_receivable_settings s
  where s.singleton = true;

  if new.source_type <> 'opening'
     and operation_start is not null
     and new.invoice_date < operation_start then
    if new.closing_id is not null or exists (
      select 1
      from public.accounts_receivable_payments p
      where p.receivable_id = new.id
    ) then
      raise exception '運用開始日前の売掛に締めまたは入金があるため除外できません。';
    end if;

    insert into public.accounts_receivable_cutover_log (
      cutover_key,
      receivable_id,
      row_data,
      archived_by
    )
    values (
      'automatic-pre-cutover-guard',
      new.id,
      to_jsonb(new),
      auth.uid()
    )
    on conflict (cutover_key, receivable_id) do update set
      row_data = excluded.row_data,
      archived_at = now(),
      archived_by = auth.uid();

    delete from public.accounts_receivable
    where id = new.id;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_remove_pre_cutover_receivable
  on public.accounts_receivable;
create trigger trg_remove_pre_cutover_receivable
after insert or update of source_type, invoice_date
on public.accounts_receivable
for each row execute function public.remove_pre_cutover_receivable();

revoke all on function public.remove_pre_cutover_receivable() from public;

do $$
begin
  if exists (
    select 1
    from public.accounts_receivable r
    where r.source_type <> 'opening'
      and r.invoice_date < date '2026-08-01'
  ) then
    raise exception '運用開始日前の売掛除外チェックに失敗しました。変更はロールバックされます。';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
