# Sales Lock Trial

このフォルダは、売上確定ロック機能のお試し版です。

## 先にSupabaseで実行するSQL

1. `sales-lock-trial-migration.sql`
2. `sales-lock-admin-example.sql`

`admin-example` は `YOUR_EMAIL_HERE` を管理者にしたいログインメールアドレスへ変更してから実行してください。

## 追加された機能

- 売上確定
- 確定後の入力ロック
- 管理者だけロック解除
- 確定売上を `sales_records` に保存

既存版へ戻す場合は、退避済みの `upload-latest-20260616-before-sales-lock-trial.zip` を使ってください。
