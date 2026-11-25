# 営業代行チーム: 輸入社07の確定売上

## 公開範囲

- 閲覧画面は `/agency-sales`。営業代行担当者ごとのメールでログインします。
- 07が明示されている確定売上・過去売上・国内経由の確定売上・反映済み売上調整が対象です。税抜金額は保存値を使い、売価×数量から再計算しません。
- 商品名・商品コード・得意先名は部分一致、拠点は完全一致で、期間内の全件を検索します。商品・得意先で絞った場合は紐づけのない送料を含めず、拠点を指定した場合は拠点不明の明細を除きます。
- 確定した輸出作業は `shipping_fees['07']` に直接割り当てられた送料のみ表示します。複数社を含む合算送料や、07への帰属を確認できない売上は表示しません。
- 解除済みの作業、未確定速報、他社売上、仕入・原価・粗利、内部メモ、請求書と売掛・入金、帳票出力、変更機能は対象外です。

## 本番導入前

1. 社内とは**別の**Supabaseプロジェクトを営業代行の認証専用に用意します。業務データや社内JWTの信頼設定はコピーしません。外部登録を無効にし、Email認証を有効にします。メール変更は両方のアドレスで確認する設定を維持してください。
2. 認証用プロジェクトに送信用SMTPを設定します。Magic LinkのメールテンプレートはURLの代わりに `{{ .Token }}` を表示して、6桁のメール確認コードとして運用します。JWTの有効期限は1800秒以下、メールコードの有効期限は業務に必要な範囲に設定します。
3. 業務DBで現行の売上確定・解除、国内売上連動のSQLが入っていることを確認し、`agency-sales-migration.sql` を適用します。関数は `service_role` でのみ実行でき、既存行も既存アカウント権限も変更しません。
4. Vercelサーバーで既存の `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`APP_ORIGIN` に加え、専用Authの `AGENCY_AUTH_SUPABASE_URL` と `AGENCY_AUTH_SUPABASE_PUBLIC_KEY`（publishableまたはanonキー）、管理画面を使うための `AGENCY_AUTH_SUPABASE_ADMIN_KEY`（専用Authのservice_role）を登録し、デプロイします。管理キーはサーバーの環境変数のみに置きます。閲覧画面を別ホストで公開する場合は `AGENCY_APP_ORIGIN` にその公開オリジンを指定します。プレビューはテストデータで実施します。
5. 先にテストアカウントで、07以外のデータ・未確定売上・社内画面やAPIにアクセスできないこと、付与解除後は既存セッションでも見られないこと、07の表示額が対象期間の保存金額と一致することを本番設定上でも確認します。

参考: [Supabaseのメール確認コード設定](https://supabase.com/docs/guides/auth/auth-email-passwordless)

## アカウント作成と停止（管理者のみ）

社内の「ユーザー管理」→「営業代行の売上閲覧」で、メールアドレスを指定して07の閲覧アカウントを発行できます。一覧から停止・再割り当てできます。現時点では07だけが割り当て可能です。

管理画面を使わず端末で操作する場合は、専用Authの `AGENCY_AUTH_SUPABASE_URL` と `AGENCY_AUTH_SUPABASE_ADMIN_KEY`（service_role）を端末の環境変数に設定します。業務DBの管理キーはこの操作に使いません。

```text
node scripts/agency-sales-users.cjs create staff@example.com
node scripts/agency-sales-users.cjs revoke USER_ID
node scripts/agency-sales-users.cjs grant USER_ID
```

作成後、登録したメールアドレスの担当者に閲覧画面のURLを知らせます。コードは担当者が画面から送信します。担当変更時は、その担当者の権限を停止します。停止は以降のデータ取得に反映されます。
