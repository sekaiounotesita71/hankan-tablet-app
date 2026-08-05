param(
  [string]$WorkingDirectory = (Join-Path ([IO.Path]::GetTempPath()) "yumirume-cloud-backup")
)

$ErrorActionPreference = "Stop"

$requiredEnvironmentVariables = @(
  "YUMIRUME_SUPABASE_SERVICE_ROLE_KEY",
  "YUMIRUME_BACKUP_ENCRYPTION_PASSWORD",
  "YUMIRUME_ONEDRIVE_DRIVE_ID"
)
foreach ($name in $requiredEnvironmentVariables) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "$name is not set."
  }
}

$root = [IO.Path]::GetFullPath($WorkingDirectory)
if ([IO.Directory]::Exists($root)) {
  Remove-Item -LiteralPath $root -Recurse -Force
}
[IO.Directory]::CreateDirectory($root) | Out-Null

try {
  & (Join-Path $PSScriptRoot "export-supabase-backup.ps1") -OutputDirectory $root
  $zipFile = Get-ChildItem -LiteralPath $root -Filter "yumirume-supabase-*.zip" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $zipFile) { throw "The exported backup ZIP was not found." }

  & (Join-Path $PSScriptRoot "verify-supabase-backup.ps1") -BackupFile $zipFile.FullName

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($zipFile.FullName)
  try {
    $manifestEntry = $archive.GetEntry("manifest.json")
    if (-not $manifestEntry) { throw "manifest.json is missing from the backup ZIP." }
    $reader = New-Object IO.StreamReader($manifestEntry.Open(), [Text.Encoding]::UTF8)
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  } finally {
    $archive.Dispose()
  }

  $encryptedFile = "$($zipFile.FullName).enc"
  & openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 `
    -in $zipFile.FullName `
    -out $encryptedFile `
    -pass env:YUMIRUME_BACKUP_ENCRYPTION_PASSWORD
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $encryptedFile -PathType Leaf)) {
    throw "Backup encryption failed."
  }
  Remove-Item -LiteralPath $zipFile.FullName -Force

  $upload = & (Join-Path $PSScriptRoot "upload-onedrive-backup.ps1") -BackupFile $encryptedFile
  $encryptedInfo = Get-Item -LiteralPath $encryptedFile
  $hash = (Get-FileHash -LiteralPath $encryptedFile -Algorithm SHA256).Hash.ToLowerInvariant()

  $result = [ordered]@{
    file_name = $encryptedInfo.Name
    folder_path = [string]$upload.folder_path
    file_size_bytes = [long]$encryptedInfo.Length
    sha256 = $hash
    table_count = [int]$manifest.table_count
    row_count = [long]$manifest.total_rows
    monthly_copy = [bool]$upload.monthly_copy
  }

  if ($env:GITHUB_OUTPUT) {
    foreach ($entry in $result.GetEnumerator()) {
      Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "$($entry.Key)=$($entry.Value)" -Encoding UTF8
    }
  }
  $resultObject = [pscustomobject]$result
  $resultObject | Format-List
  return $resultObject
} finally {
  if ([IO.Directory]::Exists($root)) {
    Remove-Item -LiteralPath $root -Recurse -Force
  }
}
