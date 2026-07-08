-- ロック解除できる管理者を登録するSQLです。
-- YOUR_EMAIL_HERE を管理者にしたいログインメールアドレスへ変更して実行してください。

insert into public.user_roles (user_id, role)
select id, 'admin'
from auth.users
where email = 'YOUR_EMAIL_HERE'
on conflict (user_id) do update
set role = excluded.role,
    updated_at = now();

