# 変更履歴・バックアップ運用

## 1. 画面からの復元

1. Supabase SQL Editorで `audit-backup-restore-migration.sql` を1回実行します。
2. 販売・業務管理へ管理者でログインします。
3. `マスタ` > `監査・復元` を開きます。
4. 日付・対象・操作で絞り込み、履歴行を選びます。
5. 変更前後を確認して `この変更を元に戻す` を押し、理由を入力します。

復元できるのは、同じレコードに対する最新の `更新` または `削除` です。古い履歴を直接戻して新しい入力を消すことはできません。復元操作も履歴へ残ります。

## 2. Supabase内バックアップ

`マスタ` > `監査・復元` > `手動バックアップ作成` は、主要テーブルの現在値をSupabase内に保存します。誤削除への即時対策ですが、Supabase自体の障害に備える外部バックアップの代わりにはなりません。

`scheduled-business-snapshot-migration.sql` を実行すると、毎日19:00（日本時間）に自動作成され、30日を超えたものは自動削除されます。

## 3. PCに依存しないOneDriveバックアップ

GitHub Actionsが毎日19:15（日本時間）にクラウド上で実行します。PCの電源状態には依存しません。

- 主要業務テーブルをJSON形式で書き出す
- 件数とSHA256を記録した `manifest.json` を作成する
- 作成直後に全ファイルのハッシュを検査する
- AES-256で暗号化してOneDriveのアプリ専用フォルダへ直接送る
- 日次バックアップは90日、月末バックアップは3年保持する
- GitHubにはバックアップ本体を保存しない
- 成功・失敗を `マスタ` > `監査・復元` に表示する

最初に `cloud-backup-monitoring-migration.sql` をSupabase SQL Editorで実行します。

### Microsoft Entraの初回設定

1. Microsoft Entra管理センターでアプリ登録 `Yumirume Cloud Backup` を作成する
2. 対象アカウントは「この組織ディレクトリのみ」にする
3. Microsoft Graphのアプリケーション権限 `Files.ReadWrite.AppFolder` を追加する
4. 管理者の同意を実行する
5. フェデレーション資格情報にGitHubを追加する
6. Organizationは `sekaiounotesita71`、Repositoryは `hankan-tablet-app`、Branchは `main` にする
7. アプリケーションIDとテナントIDを控える

OneDriveのDrive IDはMicrosoft Graph Explorerへログインし、`GET /me/drive?$select=id,webUrl` を実行して確認します。

### GitHub Actionsの初回設定

GitHubの `Settings` > `Secrets and variables` > `Actions` に次を登録します。

Variables:

- `AZURE_CLIENT_ID`: EntraのアプリケーションID
- `AZURE_TENANT_ID`: EntraのテナントID
- `ONEDRIVE_DRIVE_ID`: 保存先OneDriveのDrive ID
- `CLOUD_BACKUP_ENABLED`: 試運転成功後に `true`

Secrets:

- `SUPABASE_SERVICE_ROLE_KEY`: Supabaseのservice roleキー
- `BACKUP_ENCRYPTION_PASSWORD`: 20文字以上のバックアップ専用パスワード

秘密情報はHTML、GitHubのファイル、SQL、会話へ貼り付けません。暗号化パスワードを失うとOneDrive上のバックアップを復号できないため、社内のパスワード管理場所にも保存します。

GitHubの `Actions` > `Cloud database backup` > `Run workflow` で試運転します。成功後に `CLOUD_BACKUP_ENABLED=true` とすると、毎日19:15に自動実行されます。

## 4. 手動の外部バックアップ

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

## 5. バックアップ検査

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-supabase-backup.ps1 -BackupFile .\backups\yumirume-supabase-YYYYMMDD-HHMMSS.zip
```

`Backup verified` と表示されれば、全ファイルが作成時のハッシュと一致しています。

暗号化されたOneDriveバックアップを復号・検査する場合は、暗号化パスワードを環境変数へ設定して実行します。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\decrypt-cloud-backup.ps1 -EncryptedBackupFile .\yumirume-supabase-YYYYMMDD-HHMMSS.zip.enc
```

## 6. 定期確認

- 毎週月曜日に管理画面で最終成功日時を確認する
- 36時間以上成功がない場合は赤い警告を確認する
- 3か月ごとにOneDriveから1件ダウンロードして復号・ハッシュ検査する
- 年1回、検証環境でデータ復旧手順を通して確認する

日常の誤入力は変更履歴、30日以内の状態確認はSupabase内スナップショット、Supabase全体の障害や長期復旧はOneDriveバックアップを使います。
