$port = 9222
$endpoint = "http://127.0.0.1:$port/json/version"
$edgeExecutable = $env:EDGE_EXECUTABLE
$workspaceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$edgeUserDataDir = Join-Path $workspaceDir ".automation-user-data\edge-9222"

if (-not $edgeExecutable) {
  $defaultEdgePath = "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe"
  $defaultEdgePathX86 = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  $defaultEdgePathLocal = "${env:LocalAppData}\Microsoft\Edge\Application\msedge.exe"

  if (Test-Path $defaultEdgePath) {
    $edgeExecutable = $defaultEdgePath
  }
  elseif (Test-Path $defaultEdgePathX86) {
    $edgeExecutable = $defaultEdgePathX86
  }
  elseif (Test-Path $defaultEdgePathLocal) {
    $edgeExecutable = $defaultEdgePathLocal
  }
  else {
    $edgeExecutable = "msedge"
  }
}

New-Item -Path $edgeUserDataDir -ItemType Directory -Force | Out-Null

function Get-PortListenerProcessName {
  try {
    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction Stop |
      Select-Object -First 1
    if (-not $listener) {
      return $null
    }

    $process = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
    return $process.ProcessName
  }
  catch {
    return $null
  }
}

function Test-CdpEndpoint {
  try {
    $resp = Invoke-WebRequest -Uri $endpoint -UseBasicParsing -TimeoutSec 2
    return $resp.StatusCode -eq 200
  }
  catch {
    return $false
  }
}

if (Test-CdpEndpoint) {
  $listenerProcess = Get-PortListenerProcessName
  if ($listenerProcess -and $listenerProcess -ne "msedge") {
    Write-Output "Port $port is currently owned by '$listenerProcess'. Releasing it for Edge..."
    Stop-Process -Name $listenerProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
  else {
    Write-Output "Edge CDP already available on port $port"
    exit 0
  }
}

Write-Output "Starting Edge with fixed CDP port $port..."
Start-Process -FilePath $edgeExecutable -ArgumentList @(
  "--user-data-dir=$edgeUserDataDir",
  "--profile-directory=Default",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=$port",
  "about:blank"
)

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-CdpEndpoint) {
    Write-Output "Edge CDP is now available on port $port"
    exit 0
  }
}

Write-Error "Could not make Edge CDP available on port $port"
exit 1
