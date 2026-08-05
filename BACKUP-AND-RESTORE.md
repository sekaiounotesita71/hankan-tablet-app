# 変更履歴・バックアップ運用

## 1. 画面からの復元

1. Supabase SQL Editorで `audit-backup-restore-migration.sql` を1回実行します。
2. 販売・業務管理へ管理者でログインします。
3. `マスタ` > `監査・復元` を開きます。
4. 日付・対象・操作で絞り込み、履歴行を選びます。
5. 変更前後を確認して `この変更を元に戻す` を押し、理由を入力します。

復元できるのは、同じレコードに対する最新の `更新` または `削除` です。古い履歴を直接戻して新しい入力を消すことはできません。復元操作も履歴へ残ります。

## 2. 手動バックアップ

`マスタ` > `監査・復元` > `手動バックアップ作成` は、主要テーブルの現在値をSupabase内に保存します。誤削除への即時対策ですが、Supabase自体の障害に備える外部バックアップの代わりにはなりません。

## 3. OneDriveへの外部バックアップ

外部バックアップはサービスロールキーを使います。キーはHTML、GitHub、PowerShellファイルへ書かず、Windowsの環境変数だけに保存します。

```powershell
[Environment]::SetEnvironmentVariable(
  "YUMIRUME_SUPABASE_SERVICE_ROLE_KEY",
  "Supabaseのservice_roleキー",
  "User"
)
```

設定後、新しいPowerShellを開いて実行します。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\export-supabase-backup.ps1
```

既定ではリポジトリ内の `backups` フォルダにZIPを作ります。このフォルダはOneDrive配下のため同期されます。ZIPにはテーブル別JSON、件数、SHA256ハッシュを記録した `manifest.json` が入ります。

## 4. バックアップ検査

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-supabase-backup.ps1 -BackupFile .\backups\yumirume-supabase-YYYYMMDD-HHMMSS.zip
```

`Backup verified` と表示されれば、全ファイルが作成時のハッシュと一致しています。

## 5. 未決定事項

- 自動バックアップを実行する端末と時刻
- 保存期間（日次・月次・年次）
- Supabase Proの自動バックアップへ切り替える時期
- 外部ZIPからDB全体を復旧する際の承認者と手順
- 物理削除を全面的に論理削除へ変更する対象

これらを決めるまでは、画面内の監査・単票復元と、必要時の手動外部バックアップを使用します。
