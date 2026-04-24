$port = 9222
$endpoint = "http://127.0.0.1:$port/json/version"
$chromeExecutable = $env:CHROME_EXECUTABLE
$workspaceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$chromeUserDataDir = Join-Path $workspaceDir ".automation-user-data\chrome-9222"

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

New-Item -Path $chromeUserDataDir -ItemType Directory -Force | Out-Null

if (-not $chromeExecutable) {
  $defaultChromePath = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
  $defaultChromePathX86 = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"

  if (Test-Path $defaultChromePath) {
    $chromeExecutable = $defaultChromePath
  }
  elseif (Test-Path $defaultChromePathX86) {
    $chromeExecutable = $defaultChromePathX86
  }
  else {
    $chromeExecutable = "chrome"
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
  if ($listenerProcess -and $listenerProcess -ne "chrome") {
    Write-Output "Port $port is currently owned by '$listenerProcess'. Releasing it for Chrome..."
    Stop-Process -Name $listenerProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
  else {
    Write-Output "Chrome CDP already available on port $port"
    exit 0
  }
}

Write-Output "Starting Chrome with fixed CDP port $port..."
Start-Process -FilePath $chromeExecutable -ArgumentList @(
  "--user-data-dir=$chromeUserDataDir",
  "--profile-directory=Default",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=$port",
  "about:blank"
)

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-CdpEndpoint) {
    Write-Output "Chrome CDP is now available on port $port"
    exit 0
  }
}

Write-Error "Could not make Chrome CDP available on port $port"
exit 1
