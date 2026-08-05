param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile
)

$ErrorActionPreference = "Stop"
$zipPath = [IO.Path]::GetFullPath($BackupFile)
if (-not [IO.File]::Exists($zipPath)) { throw "Backup file was not found: $zipPath" }

$verifyRoot = Join-Path ([IO.Path]::GetTempPath()) ("yumirume-backup-verify-" + [guid]::NewGuid().ToString("N"))
[IO.Directory]::CreateDirectory($verifyRoot) | Out-Null

try {
  Expand-Archive -LiteralPath $zipPath -DestinationPath $verifyRoot -Force
  $manifestPath = Join-Path $verifyRoot "manifest.json"
  if (-not [IO.File]::Exists($manifestPath)) { throw "manifest.json is missing from the backup." }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $errors = New-Object System.Collections.Generic.List[string]

  foreach ($entry in $manifest.tables) {
    $dataPath = Join-Path $verifyRoot $entry.file
    if (-not [IO.File]::Exists($dataPath)) {
      $errors.Add("Missing file: $($entry.file)")
      continue
    }
    $actualHash = (Get-FileHash -LiteralPath $dataPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne [string]$entry.sha256) {
      $errors.Add("Hash mismatch: $($entry.file)")
    }
  }

  if ($errors.Count) {
    $errors | ForEach-Object { Write-Error $_ }
    throw "Backup verification failed with $($errors.Count) error(s)."
  }

  Write-Host "Backup verified"
  Write-Host "Created: $($manifest.created_at)"
  Write-Host "Tables: $($manifest.table_count)"
  Write-Host "Rows: $($manifest.total_rows)"
} finally {
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolvedVerifyRoot = [IO.Path]::GetFullPath($verifyRoot)
  if ([IO.Directory]::Exists($resolvedVerifyRoot) -and $resolvedVerifyRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedVerifyRoot -Recurse -Force
  }
}
