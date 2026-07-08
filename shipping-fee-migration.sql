-- 送料入力用カラムを既存Supabase環境へ追加します。
-- Supabase Dashboard > SQL Editor で実行してください。
-- sales-lock-trial-migration.sql を再実行する場合、このSQLは不要です。

alter table public.work_sessions
  add column if not exists shipping_fee numeric not null default 0,
  add column if not exists shipping_fees jsonb not null default '{}'::jsonb;

-- Supabase API(PostgREST)へDDL変更を即時反映します。
notify pgrst, 'reload schema';
