# Hankan Tablet App

このフォルダは、Vercelにアップロードするための公開用セットです。

## 入っているもの

- `index.html`  
  タブレットで開く本体です。

- `vercel.json`  
  Vercel用の設定です。更新したHTMLが古いキャッシュで残りにくいようにしています。

## まず試す方法

1. `index.html` をダブルクリックして開く
2. 画面が開くことを確認する
3. 問題なければ、このフォルダをGitHubにアップロードする

## GitHubにアップロードする方法

1. GitHubにログイン
2. 右上の `+` から `New repository`
3. Repository name に例として `hankan-tablet-app` と入れる
4. `Public` または `Private` を選ぶ
5. `Create repository`
6. 作ったリポジトリ画面で `uploading an existing file` を選ぶ
7. この `deploy-vercel` フォルダ内のファイルをアップロード
   - `index.html`
   - `vercel.json`
   - `.gitignore`
   - `README.md`
8. `Commit changes` を押す

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

## 重要

この段階では、まだ複数人の入力共有はできません。

Vercelに上げると「みんなが同じ画面を開ける」状態になりますが、入力データは各端末のブラウザ内だけです。

複数人の入力を即時反映するには、次の段階でSupabaseなどの共有データベースに接続します。

## 次にやること

1. Supabaseプロジェクトを作る
2. `supabase-schema.sql` をSupabaseのSQL Editorに貼って実行する
3. Supabase Authenticationでログイン方法を設定する
4. このHTMLからSupabaseへ保存する
5. 他の端末へRealtimeで反映する
6. Excel出力前にSupabaseから最新データを取り直す

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

最初の設定では、ログイン済みユーザーだけが読み書きできます。
現場チーム以外をSupabase Authに招待しない運用なら、まずはこの設定で進められます。
