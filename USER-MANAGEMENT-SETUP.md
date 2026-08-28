# ユーザー管理の初期設定

ユーザー管理APIは、ブラウザへ管理用の秘密鍵を渡さず、Vercel上だけで動作します。

## Vercelへ登録する環境変数

Vercelの対象プロジェクトで `Settings` → `Environment Variables` を開き、次を登録します。

- `SUPABASE_SERVICE_ROLE_KEY`: Supabaseの `service_role` キー。Production、Preview、Developmentに登録します。
- `SUPABASE_URL`: `https://bvgjscxyjosjqqhxutyk.supabase.co`
- `APP_ORIGIN`: `https://hankan-tablet-app.vercel.app`

`SUPABASE_SERVICE_ROLE_KEY` はGitHubやHTMLへ記載しません。登録後にVercelを再デプロイします。

## Supabase AuthのURL設定

Supabaseの `Authentication` → `URL Configuration` で、次を設定します。

- Site URL: `https://hankan-tablet-app.vercel.app`
- Redirect URLs: `https://hankan-tablet-app.vercel.app/**`

Site URLが初期値のlocalhostのままだと、招待メールを開いた端末から業務アプリへ戻れません。

## 利用方法

1. 管理者で販売・業務管理へログインします。
2. `ユーザー` を開きます。
3. 氏名、メール、利用区分、拠点を入力します。
4. 外部作業者の場合は発注先コードも指定します。
5. `招待メールを送る` を押します。
6. 招待された人はメールのリンクから初回パスワードを設定します。

招待リンクを一度開いた後に設定を完了できなかった場合は、対象ユーザーを一覧から選択して `パスワード再設定メール` を送ります。古い招待メールを繰り返し使用しません。

利用を止める場合はユーザーを選び、`利用を有効にする`を外して保存します。監査履歴とのつながりを残すため、通常はAuthユーザーを削除しません。
