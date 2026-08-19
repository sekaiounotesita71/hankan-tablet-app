-- 売掛運用の基準日を登録します。売上原本や既存明細は削除しません。
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

notify pgrst, 'reload schema';

commit;
