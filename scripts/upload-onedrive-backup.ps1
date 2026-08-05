param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile,
  [string]$DriveId = $env:YUMIRUME_ONEDRIVE_DRIVE_ID,
  [int]$DailyRetentionDays = 90,
  [int]$MonthlyRetentionDays = 1095
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $BackupFile -PathType Leaf)) {
  throw "Backup file was not found: $BackupFile"
}
if ([string]::IsNullOrWhiteSpace($DriveId)) {
  throw "YUMIRUME_ONEDRIVE_DRIVE_ID is not set."
}

function Get-GraphAccessToken {
  if (-not [string]::IsNullOrWhiteSpace($env:YUMIRUME_GRAPH_ACCESS_TOKEN)) {
    return $env:YUMIRUME_GRAPH_ACCESS_TOKEN
  }

  $token = & az account get-access-token --resource-type ms-graph --query accessToken -o tsv
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
    throw "Microsoft Graph access token could not be obtained."
  }
  return [string]$token
}

$graphToken = Get-GraphAccessToken
$graphHeaders = @{ Authorization = "Bearer $graphToken" }
$graphBase = "https://graph.microsoft.com/v1.0/drives/$([uri]::EscapeDataString($DriveId))"

function Invoke-GraphJson {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [object]$Body
  )

  $arguments = @{
    Method = $Method
    Uri = $Uri
    Headers = $graphHeaders
  }
  if ($null -ne $Body) {
    $arguments.ContentType = "application/json"
    $arguments.Body = $Body | ConvertTo-Json -Depth 8
  }
  Invoke-RestMethod @arguments
}

function Get-HttpStatusCode {
  param([object]$ErrorRecord)
  try { return [int]$ErrorRecord.Exception.Response.StatusCode } catch { return 0 }
}

function Get-OrCreateFolder {
  param(
    [Parameter(Mandatory = $true)][string]$ParentId,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $encodedName = [uri]::EscapeDataString($Name)
  try {
    return Invoke-GraphJson -Method Get -Uri "${graphBase}/items/${ParentId}:/${encodedName}"
  } catch {
    if ((Get-HttpStatusCode $_) -ne 404) { throw }
  }

  $body = @{
    name = $Name
    folder = @{}
    "@microsoft.graph.conflictBehavior" = "fail"
  }
  try {
    return Invoke-GraphJson -Method Post -Uri "${graphBase}/items/${ParentId}/children" -Body $body
  } catch {
    if ((Get-HttpStatusCode $_) -ne 409) { throw }
    return Invoke-GraphJson -Method Get -Uri "${graphBase}/items/${ParentId}:/${encodedName}"
  }
}

function Send-OneDriveFile {
  param(
    [Parameter(Mandatory = $true)][string]$FolderId,
    [Parameter(Mandatory = $true)][string]$FilePath
  )

  $file = Get-Item -LiteralPath $FilePath
  $encodedName = [uri]::EscapeDataString($file.Name)
  if ($file.Length -le 200MB) {
    return Invoke-RestMethod -Method Put `
      -Uri "${graphBase}/items/${FolderId}:/${encodedName}:/content" `
      -Headers $graphHeaders `
      -ContentType "application/octet-stream" `
      -InFile $file.FullName
  }

  $session = Invoke-GraphJson -Method Post `
    -Uri "${graphBase}/items/${FolderId}:/${encodedName}:/createUploadSession" `
    -Body @{ item = @{ "@microsoft.graph.conflictBehavior" = "replace"; name = $file.Name } }
  if ([string]::IsNullOrWhiteSpace($session.uploadUrl)) {
    throw "OneDrive upload session was not created."
  }

  $chunkSize = 10MB
  $stream = [IO.File]::OpenRead($file.FullName)
  try {
    $offset = 0L
    $result = $null
    while ($offset -lt $stream.Length) {
      $remaining = $stream.Length - $offset
      $readSize = [int][Math]::Min($chunkSize, $remaining)
      $buffer = New-Object byte[] $readSize
      $actualRead = $stream.Read($buffer, 0, $readSize)
      if ($actualRead -ne $readSize) { throw "Backup file could not be read completely." }
      $end = $offset + $actualRead - 1
      $headers = @{
        "Content-Length" = [string]$actualRead
        "Content-Range" = "bytes $offset-$end/$($stream.Length)"
      }
      $result = Invoke-RestMethod -Method Put -Uri $session.uploadUrl -Headers $headers -ContentType "application/octet-stream" -Body $buffer
      $offset += $actualRead
    }
    return $result
  } finally {
    $stream.Dispose()
  }
}

function Remove-ExpiredFiles {
  param(
    [Parameter(Mandatory = $true)][string]$FolderId,
    [Parameter(Mandatory = $true)][int]$RetentionDays
  )

  $cutoff = (Get-Date).ToUniversalTime().AddDays(-$RetentionDays)
  $uri = "${graphBase}/items/${FolderId}/children?`$select=id,name,createdDateTime,file&`$top=200"
  while ($uri) {
    $page = Invoke-GraphJson -Method Get -Uri $uri
    foreach ($item in @($page.value)) {
      if ($null -eq $item.file -or -not $item.createdDateTime) { continue }
      $createdAt = [datetimeoffset]::Parse([string]$item.createdDateTime)
      if ($createdAt.UtcDateTime -lt $cutoff) {
        Invoke-RestMethod -Method Delete -Uri "${graphBase}/items/$($item.id)" -Headers $graphHeaders | Out-Null
        Write-Host "Expired OneDrive backup deleted: $($item.name)"
      }
    }
    $uri = $page.'@odata.nextLink'
  }
}

function Get-JapanNow {
  try {
    $timezone = [TimeZoneInfo]::FindSystemTimeZoneById("Asia/Tokyo")
  } catch {
    $timezone = [TimeZoneInfo]::FindSystemTimeZoneById("Tokyo Standard Time")
  }
  [TimeZoneInfo]::ConvertTime([datetimeoffset]::UtcNow, $timezone)
}

$appRoot = Invoke-GraphJson -Method Get -Uri "$graphBase/special/approot"
$dailyFolder = Get-OrCreateFolder -ParentId $appRoot.id -Name "daily"
$monthlyFolder = Get-OrCreateFolder -ParentId $appRoot.id -Name "monthly"

$dailyResult = Send-OneDriveFile -FolderId $dailyFolder.id -FilePath $BackupFile
$japanNow = Get-JapanNow
$isMonthEnd = $japanNow.AddDays(1).Month -ne $japanNow.Month
if ($isMonthEnd) {
  Send-OneDriveFile -FolderId $monthlyFolder.id -FilePath $BackupFile | Out-Null
}

Remove-ExpiredFiles -FolderId $dailyFolder.id -RetentionDays $DailyRetentionDays
Remove-ExpiredFiles -FolderId $monthlyFolder.id -RetentionDays $MonthlyRetentionDays

[pscustomobject]@{
  file_name = [IO.Path]::GetFileName($BackupFile)
  folder_path = "Apps/Yumirume Cloud Backup/daily"
  web_url = $dailyResult.webUrl
  monthly_copy = $isMonthEnd
}
