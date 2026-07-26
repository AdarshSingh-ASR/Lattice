param(
  [string]$ClusterName = "river-gnoll"
)

$ErrorActionPreference = "Stop"
$ccloudCommand = Get-Command ccloud -ErrorAction SilentlyContinue
$ccloudPath = if ($ccloudCommand) { $ccloudCommand.Source } else { $null }
if (-not $ccloudPath) {
  $fallback = Join-Path $env:APPDATA "ccloud\ccloud.exe"
  if (Test-Path -LiteralPath $fallback) {
    $ccloudPath = $fallback
  }
}
if (-not $ccloudPath) {
  throw "ccloud is required. See https://www.cockroachlabs.com/docs/cockroachcloud/ccloud-get-started"
}

$cluster = (& $ccloudPath cluster info $ClusterName --output json --quiet) | ConvertFrom-Json
$users = (& $ccloudPath cluster user list $ClusterName --output json --quiet) | ConvertFrom-Json

$assessment = [ordered]@{
  checked_at = (Get-Date).ToUniversalTime().ToString("o")
  cluster = $cluster.name
  cluster_id = $cluster.id
  state = $cluster.state
  cloud = $cluster.cloud_provider
  regions = @($cluster.regions | ForEach-Object { $_.name })
  version = $cluster.cockroach_version
  network_visibility = $cluster.network_visibility
  sql_users = @($users | ForEach-Object { $_.name })
  checks = [ordered]@{
    running = ($cluster.state -in @("CREATED", "RUNNING"))
    aws_region = (@($cluster.regions | Where-Object { $_.name -like "ap-*" -or $_.name -like "us-*" -or $_.name -like "eu-*" }).Count -gt 0)
    application_user_present = (@($users | Where-Object { $_.name -eq "lattice_app" }).Count -eq 1)
    public_network_acknowledged = ($cluster.network_visibility -eq "PUBLIC")
  }
  skill_receipt = [ordered]@{
    name = "reviewing-cluster-health"
    source = "cockroachlabs/cockroachdb-skills"
    mode = "Basic cluster / read-only ccloud assessment"
  }
}

$assessment | ConvertTo-Json -Depth 8
