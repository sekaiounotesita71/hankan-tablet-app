# Hankan Tablet App

このフォルダは、Vercelにアップロードするための公開用セットです。

## 入っているもの

- `index.html`  
  タブレットで開く本体です。

- `order-entry-beta.html`
  発注入力、外部作業依頼、仕入管理、マスタ管理を行う画面です。

- `partner-work.html`
  問屋・外部拠点の担当者が、割り当てられた明細だけを入力する画面です。

- `vercel.json`  
  Vercel用の設定です。更新したHTMLが古いキャッシュで残りにくいようにしています。

- `product-master-migration.sql`  
  既存のSupabase環境へ商品マスタ保存機能を追加するSQLです。

- `invoice-export-settings-migration.sql`
  輸入社別のInvoiceヘッダー、仕向け地別の商品表記、Excel出力履歴を追加するSQLです。

- `sales-correction-all-sources-migration.sql`
  売上参照から赤伝・調整・過去取込データを管理者修正するためのSQLです。

- `site-partner-purchase-migration.sql`
  大阪・東京の拠点、外部担当者の権限制御、問屋作業、仕入予定、事前仕入、在庫を追加するSQLです。

- `advance-purchase-batch-migration.sql`
  発注を伴わない仕入を、複数明細の1伝票として一括登録する追加SQLです。

- `audit-backup-restore-migration.sql`
  受注・作業・売上・売掛・仕入・買掛・マスタの変更履歴と、管理者による安全な単票復元、手動バックアップを追加するSQLです。

- `scheduled-business-snapshot-migration.sql`
  毎日19:00（日本時間）に主要業務データのスナップショットを自動作成し、30日間保持するSQLです。`audit-backup-restore-migration.sql` の後に1回実行します。

- `cloud-backup-monitoring-migration.sql`
  PCに依存しないOneDriveバックアップの成功・失敗を管理画面へ表示するSQLです。

- `.github/workflows/cloud-database-backup.yml`
  毎日19:15（日本時間）に暗号化バックアップをOneDriveへ直接保存するGitHub Actionsです。

- `scripts/export-supabase-backup.ps1`
  Supabaseの主要データをOneDrive配下へZIP保存する外部バックアップ用スクリプトです。秘密鍵は環境変数からだけ読み込みます。

## まず試す方法

1. `index.html` をダブルクリックして開く
2. 画面が開くことを確認する
3. 問題なければ、このフォルダをGitHubにアップロードする

## GitHub Desktopで反映する方法

手動アップロードは最新版が分かりにくくなるため、今後はGitHub Desktopで管理します。

1. GitHub Desktopでこの `deploy-vercel` フォルダをリポジトリとして開く
2. Codexが修正した差分をGitHub Desktopで確認する
3. Summaryに変更内容を書く
4. `Commit to main` を押す
5. `Push origin` を押す
6. VercelがGitHubの更新を検知して自動デプロイする

本番反映するファイルはこのフォルダ内を正とします。

- `index.html`
- `order-entry-beta.html`
- `vercel.json`
- Supabase用SQL

ローカル確認用の別HTMLは本番反映対象にしません。

## Vercelに公開する方法

1. Vercelにログイン
2. `Add New...` → `Project`
3. GitHub連携を許可
4. `hankan-tablet-app` を選ぶ
5. Framework Preset は `Other` のままでOK
6. Build Command は空欄でOK
7. Output Directory も空欄でOK
8. `Deploy` を押す

完了すると、次のようなURLができます。

```text
https://hankan-tablet-app.vercel.app
```

このURLをタブレットで開けば、同じ画面を使えます。

## 商品マスタの使い方

1. 既存環境では、Supabase SQL Editorで `product-master-migration.sql` を1回だけ実行する
2. アプリへログインする
3. 初回だけ商品マスタCSVを読み込む
4. 以後はログイン時にSupabaseから商品マスタが自動取得される
5. 商品マスタに変更があった時だけ、新しいCSVを読み込む

CSV更新時は商品コード単位で上書きされます。CSVに含まれない既存商品は削除されません。

## Invoice出力設定

1. Supabase SQL Editorで `invoice-export-settings-migration.sql` を1回実行する
2. `scheduled-business-snapshot-migration.sql` を再実行し、新しい3テーブルを定期スナップショット対象へ加える
3. 販売管理の `マスタ` → `Invoice出力` を開く
4. 輸入社コードを選び、Shipper、Consignee、輸送条件、Invoice番号の3桁を保存する
5. 商品ごとに通関申告用の商品名・英名・産地・PACKING・HSコードを登録する
6. 現場作業のExcel出力画面で必須確認が0件になっていることを確認して出力する

商品表記は輸入社と商品コードを基本に適用します。産地や作業用商品名を条件にした登録がある場合は、その条件を優先します。作業画面の商品名は変更されません。

商品コードが商品マスタにない場合でも、日本語商品名が既存の商品マスタまたは同じ輸入社の過去の確定表記と完全一致し、英名・学術名が1種類に決まる場合は自動補完します。同名で候補が複数ある場合は自動確定しません。商品コードを `*` にした表記ルールは、日本語名の完全一致で使う名称辞書として再利用できます。

## Supabase SQLの使い方

1. Supabase Dashboardを開く
2. 対象プロジェクトを選ぶ
3. 左メニューの `SQL Editor`
4. `New query`
5. このフォルダの `supabase-schema.sql` の中身を全部コピー
6. SQL Editorに貼り付ける
7. `Run` を押す

作成されるテーブル:

- `work_sessions`
- `order_lines`
- `boxes`
- `product_master`

最初の設定では、ログイン済みユーザーだけが読み書きできます。
現場チーム以外をSupabase Authに招待しない運用なら、まずはこの設定で進められます。

## 拠点・問屋入力・仕入管理の初期設定

既存の各SQLを実行済みの環境で、`site-partner-purchase-migration.sql`、続けて `advance-purchase-batch-migration.sql` を1回ずつ実行します。同じSQLを再実行しても既存データを消さない構成です。

実行時の初期設定:

- 拠点は `OSA = 大阪`、`TYO = 東京`
- 既存の得意先、受注、作業、売上はすべて大阪へ設定
- 既存のSupabase Authユーザーは社内ユーザーとして維持
- 外部担当者は割り当てられた発注先・拠点の明細だけ参照可能
- 売価、売上、他の発注先、各マスタは外部担当者から非表示

問屋入力を開始する手順:

1. マスタ画面の仕入先マスタで「外部作業を依頼する仕入先」を有効にする
2. 仕入先ごとの固定箱コードと既定拠点を登録する
3. Supabaseの `Authentication` で担当者ごとのログインアカウントを作成する
4. 発注入力の「外部作業」から、担当者メールと発注先コードを紐付ける
5. 受注を確定後、作業日・拠点・発注先を指定して「問屋へ依頼公開」を押す
6. 担当者は `/partner-work.html` へログインして、割り当て明細を入力・提出する
7. 本社が提出内容を確認し、「確認済みにする」または「差し戻す」を選ぶ
8. 確認済みの数量・箱情報は、同じ日付・拠点の作業アプリへ反映される
9. 仕入管理で請求書番号、送料、税額等を照合し、仕入確定する

得意先の作業拠点は得意先マスタで固定します。新しい受注では得意先を選ぶと大阪・東京が自動表示され、通常の受注入力から拠点を直接変更しません。

発注を伴わない事前仕入は、仕入管理の「発注を伴わない事前仕入」から、共通情報を1回入力して複数明細を一括登録します。在庫管理は明細ごとに任意で選択できます。

## 変更履歴・復元・バックアップ

既存の各SQLを実行済みの環境で、`audit-backup-restore-migration.sql` を1回実行します。

- 管理者は `マスタ` > `監査・復元` で主要業務の変更履歴を確認できます。
- 同じレコードの最新の更新・削除だけ、理由入力後に変更前へ戻せます。
- 復元操作も監査ログへ記録されます。
- `手動バックアップ作成` はSupabase内へ現在値を保存します。
- `scheduled-business-snapshot-migration.sql` 実行後は、毎日19:00（日本時間）に自動バックアップが作成されます。
- `cloud-backup-monitoring-migration.sql` 実行後は、OneDrive外部バックアップの最終成功・失敗を同じ画面で確認できます。
- Supabase障害にも備える外部バックアップは `BACKUP-AND-RESTORE.md` の手順でOneDriveへ保存します。
