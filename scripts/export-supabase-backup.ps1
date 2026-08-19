param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\backups"),
  [string]$ProjectUrl = $env:YUMIRUME_SUPABASE_URL,
  [int]$PageSize = 1000
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectUrl)) {
  $ProjectUrl = "https://bvgjscxyjosjqqhxutyk.supabase.co"
}
$ProjectUrl = $ProjectUrl.TrimEnd("/")

$serviceRoleKey = $env:YUMIRUME_SUPABASE_SERVICE_ROLE_KEY
if ([string]::IsNullOrWhiteSpace($serviceRoleKey)) {
  throw "YUMIRUME_SUPABASE_SERVICE_ROLE_KEY is not set. Do not put the service-role key in this script."
}
$backupUserAgent = "YumirumeCloudBackup/1.0"

$tables = @(
  "work_sessions", "order_lines", "boxes", "sales_records",
  "order_entry_batches", "order_entry_lines", "pending_entries", "historical_sales_records",
  "accounts_receivable", "accounts_receivable_payments", "accounts_receivable_statement_profiles",
  "accounts_receivable_statements", "accounts_receivable_closings",
  "external_work_assignments", "external_work_assignment_lines", "external_work_inputs",
  "purchase_receipts", "purchase_receipt_lines", "inventory_lots", "inventory_allocations",
  "accounts_payable_supplier_profiles", "accounts_payable", "accounts_payable_payments",
  "importer_master", "supplier_master", "product_master", "product_price_contracts", "customer_master",
  "invoice_profiles", "invoice_product_rules", "invoice_export_logs",
  "product_guide_templates", "product_guide_variants", "product_guide_template_rows",
  "site_master", "internal_user_access", "partner_user_access", "user_roles",
  "audit_events", "audit_snapshots", "external_backup_runs"
)
$optionalTables = @(
  "invoice_profiles", "invoice_product_rules", "invoice_export_logs"
)
$tableOrder = @{
  work_sessions = "id"; order_lines = "id"; boxes = "id"; sales_records = "id"
  order_entry_batches = "id"; order_entry_lines = "id"; pending_entries = "id"; historical_sales_records = "id"
  accounts_receivable = "id"; accounts_receivable_payments = "id"; accounts_receivable_statement_profiles = "importer_code"
  accounts_receivable_statements = "id"; accounts_receivable_closings = "id"
  external_work_assignments = "id"; external_work_assignment_lines = "id"; external_work_inputs = "assignment_line_id"
  purchase_receipts = "id"; purchase_receipt_lines = "id"; inventory_lots = "id"; inventory_allocations = "id"
  accounts_payable_supplier_profiles = "supplier_code"; accounts_payable = "id"; accounts_payable_payments = "id"
  importer_master = "importer_code"; supplier_master = "supplier_code"; product_master = "product_id"
  product_price_contracts = "product_id,importer_code"; customer_master = "id"
  invoice_profiles = "importer_code"; invoice_product_rules = "id"; invoice_export_logs = "id"
  product_guide_templates = "id"; product_guide_variants = "id"; product_guide_template_rows = "id"
  site_master = "site_code"; internal_user_access = "user_id"; partner_user_access = "user_id,supplier_code"
  user_roles = "user_id"; audit_events = "id"; audit_snapshots = "id"; external_backup_runs = "id"
}

$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tempRoot = [IO.Path]::GetFullPath((Join-Path $outputRoot ".building-$stamp"))
$zipPath = Join-Path $outputRoot "yumirume-supabase-$stamp.zip"

if (-not $tempRoot.StartsWith($outputRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Temporary backup path escaped the output directory."
}

[IO.Directory]::CreateDirectory($tempRoot) | Out-Null
$manifestTables = New-Object System.Collections.Generic.List[object]

try {
  foreach ($table in $tables) {
    $pageChunks = New-Object System.Collections.Generic.List[string]
    $rowCount = 0
    $offset = 0
    $skipTable = $false

    while ($true) {
      $headers = @{
        apikey = $serviceRoleKey
        Authorization = "Bearer $serviceRoleKey"
        Accept = "application/json"
      }
      $order = (($tableOrder[$table] -split ",") | ForEach-Object { "$_.asc" }) -join ","
      $uri = "$ProjectUrl/rest/v1/$table`?select=*&order=$([uri]::EscapeDataString($order))&limit=$PageSize&offset=$offset"
      try {
        $response = Invoke-WebRequest -Method Get -Uri $uri -Headers $headers -UserAgent $backupUserAgent -UseBasicParsing
      } catch {
        $errorText = "$($_.Exception.Message) $($_.ErrorDetails.Message)"
        $isMissingOptionalTable = $offset -eq 0 -and
          $optionalTables -contains $table -and
          $errorText -match "404|PGRST205|Could not find the table|relation.+does not exist"
        if (-not $isMissingOptionalTable) { throw }
        Write-Warning "Skipping optional table $table because its migration has not been applied yet."
        $skipTable = $true
        break
      }
      $rawPage = [string]$response.Content
      $page = @($rawPage | ConvertFrom-Json)
      if ($page.Count) {
        $trimmedPage = $rawPage.Trim()
        if (-not ($trimmedPage.StartsWith("[") -and $trimmedPage.EndsWith("]"))) {
          throw "Unexpected REST response for table $table."
        }
        $innerJson = $trimmedPage.Substring(1, $trimmedPage.Length - 2).Trim()
        if ($innerJson) { $pageChunks.Add($innerJson) }
        $rowCount += $page.Count
      }
      if ($page.Count -lt $PageSize) { break }
      $offset += $PageSize
    }

    if ($skipTable) { continue }

    $jsonPath = Join-Path $tempRoot "$table.json"
    $json = "[" + ($pageChunks -join ",") + "]"
    [IO.File]::WriteAllText($jsonPath, $json, [Text.UTF8Encoding]::new($false))
    $hash = (Get-FileHash -LiteralPath $jsonPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestTables.Add([pscustomobject]@{
      table = $table
      rows = $rowCount
      file = "$table.json"
      sha256 = $hash
    })
    Write-Host ("{0,-44} {1,8} rows" -f $table, $rowCount)
  }

  $manifest = [ordered]@{
    format_version = 1
    project_url = $ProjectUrl
    created_at = (Get-Date).ToUniversalTime().ToString("o")
    created_on = $env:COMPUTERNAME
    table_count = $manifestTables.Count
    total_rows = ($manifestTables | Measure-Object -Property rows -Sum).Sum
    tables = $manifestTables
  }
  $manifestPath = Join-Path $tempRoot "manifest.json"
  [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))

  Compress-Archive -Path (Join-Path $tempRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal -Force
  $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Host ""
  Write-Host "Backup complete"
  Write-Host "File: $zipPath"
  Write-Host "SHA256: $zipHash"
} finally {
  if ([IO.Directory]::Exists($tempRoot) -and $tempRoot.StartsWith($outputRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
