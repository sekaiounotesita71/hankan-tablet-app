# Hankan Tablet App

このフォルダは、Vercelにアップロードするための公開用セットです。

## 入っているもの

- `index.html`  
  タブレットで開く本体です。

- `vercel.json`  
  Vercel用の設定です。更新したHTMLが古いキャッシュで残りにくいようにしています。

- `product-master-migration.sql`  
  既存のSupabase環境へ商品マスタ保存機能を追加するSQLです。

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
