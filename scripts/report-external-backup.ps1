param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("running", "complete", "failed")]
  [string]$Status,
  [string]$ExecutionKey = $env:YUMIRUME_BACKUP_EXECUTION_KEY,
  [string]$WorkflowUrl = $env:YUMIRUME_BACKUP_WORKFLOW_URL,
  [string]$FileName,
  [string]$FolderPath,
  [long]$FileSizeBytes = 0,
  [string]$Sha256,
  [int]$TableCount = 0,
  [long]$RowCount = 0,
  [string]$ErrorMessage,
  [string]$ProjectUrl = $env:YUMIRUME_SUPABASE_URL
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ExecutionKey)) {
  throw "YUMIRUME_BACKUP_EXECUTION_KEY is not set."
}
if ([string]::IsNullOrWhiteSpace($ProjectUrl)) {
  $ProjectUrl = "https://bvgjscxyjosjqqhxutyk.supabase.co"
}
$ProjectUrl = $ProjectUrl.TrimEnd("/")

$serviceRoleKey = $env:YUMIRUME_SUPABASE_SERVICE_ROLE_KEY
if ([string]::IsNullOrWhiteSpace($serviceRoleKey)) {
  throw "YUMIRUME_SUPABASE_SERVICE_ROLE_KEY is not set."
}
$backupUserAgent = "YumirumeCloudBackup/1.0"

$headers = @{
  apikey = $serviceRoleKey
  Authorization = "Bearer $serviceRoleKey"
  "Content-Type" = "application/json"
  Prefer = "resolution=merge-duplicates,missing=default,return=minimal"
}

$payload = [ordered]@{
  execution_key = $ExecutionKey
  status = $Status
  storage_provider = "onedrive"
  workflow_url = $WorkflowUrl
  updated_at = (Get-Date).ToUniversalTime().ToString("o")
}

if ($Status -eq "running") {
  $payload.started_at = (Get-Date).ToUniversalTime().ToString("o")
} else {
  $payload.completed_at = (Get-Date).ToUniversalTime().ToString("o")
}
if ($FileName) { $payload.file_name = $FileName }
if ($FolderPath) { $payload.folder_path = $FolderPath }
if ($FileSizeBytes -gt 0) { $payload.file_size_bytes = $FileSizeBytes }
if ($Sha256) { $payload.sha256 = $Sha256 }
if ($TableCount -gt 0) { $payload.table_count = $TableCount }
if ($RowCount -gt 0) { $payload.row_count = $RowCount }
if ($ErrorMessage) { $payload.error_message = $ErrorMessage.Substring(0, [Math]::Min(1500, $ErrorMessage.Length)) }

$uri = "$ProjectUrl/rest/v1/external_backup_runs?on_conflict=execution_key"
Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -UserAgent $backupUserAgent -Body ($payload | ConvertTo-Json -Depth 5) | Out-Null
Write-Host "External backup status recorded: $Status"
