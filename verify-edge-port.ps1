$edgeProcesses = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'"

if (-not $edgeProcesses) {
  Write-Output "Edge is not running."
  exit 1
}

$ports = @()

foreach ($proc in $edgeProcesses) {
  $cmd = $proc.CommandLine
  if (-not $cmd) {
    continue
  }

  if ($cmd -match "--remote-debugging-port=(\d+)") {
    $ports += [int]$matches[1]
  }
}

$ports = $ports | Sort-Object -Unique

if ($ports.Count -gt 0) {
  Write-Output "Edge remote debugging port(s): $($ports -join ', ')"
  exit 0
}

Write-Output "Edge is running, but no --remote-debugging-port flag found."
exit 2
