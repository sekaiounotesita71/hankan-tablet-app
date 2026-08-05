param(
  [Parameter(Mandatory = $true)]
  [string]$EncryptedBackupFile,
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\restored-backups")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $EncryptedBackupFile -PathType Leaf)) {
  throw "Encrypted backup file was not found: $EncryptedBackupFile"
}
if ([string]::IsNullOrWhiteSpace($env:YUMIRUME_BACKUP_ENCRYPTION_PASSWORD)) {
  throw "YUMIRUME_BACKUP_ENCRYPTION_PASSWORD is not set."
}

$destination = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($destination) | Out-Null
$sourceName = [IO.Path]::GetFileName($EncryptedBackupFile)
$zipName = if ($sourceName.EndsWith(".enc")) { $sourceName.Substring(0, $sourceName.Length - 4) } else { "$sourceName.zip" }
$zipPath = Join-Path $destination $zipName

& openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 `
  -in $EncryptedBackupFile `
  -out $zipPath `
  -pass env:YUMIRUME_BACKUP_ENCRYPTION_PASSWORD
if ($LASTEXITCODE -ne 0) { throw "Backup decryption failed." }

& (Join-Path $PSScriptRoot "verify-supabase-backup.ps1") -BackupFile $zipPath
Write-Host "Decrypted backup: $zipPath"
