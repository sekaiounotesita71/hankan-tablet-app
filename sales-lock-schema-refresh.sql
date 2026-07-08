-- 売上確定で「work_sessionsにロック用カラムがありません」と出る場合の修復SQLです。
-- Supabase Dashboard > SQL Editor で実行してください。

alter table public.work_sessions
  add column if not exists locked boolean not null default false,
  add column if not exists finalized_at timestamptz,
  add column if not exists finalized_by uuid references auth.users(id),
  add column if not exists shipping_fee numeric not null default 0,
  add column if not exists shipping_fees jsonb not null default '{}'::jsonb,
  add column if not exists unlocked_at timestamptz,
  add column if not exists unlocked_by uuid references auth.users(id),
  add column if not exists unlock_reason text;

notify pgrst, 'reload schema';
