param(
  [int]$Port = 9526,
  [string]$HostAddress = "0.0.0.0",
  [string]$DataDir = "",
  [string]$DefaultCwd = "",
  [switch]$DesktopBridge,
  [switch]$Restart,
  [switch]$Foreground,
  [switch]$NoQr
)

$ErrorActionPreference = "Stop"
if ($Foreground -and $Restart) {
  throw "-Restart is only supported for the background service mode."
}
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if ($DataDir) {
  $env:CODEX_WEBUI_DATA_DIR = [System.IO.Path]::GetFullPath($DataDir)
}
if ($DefaultCwd) {
  $env:CODEX_WEBUI_CWD = (Resolve-Path $DefaultCwd).Path
}
$env:PORT = [string]$Port
$env:HOST = $HostAddress

Push-Location $ProjectRoot
try {
  if (!(Test-Path (Join-Path $ProjectRoot "node_modules"))) {
    npm install
  }
  npm run setup

  if ($Foreground) {
    npm start
    return
  }

  $ResolvedDataDir = if ($env:CODEX_WEBUI_DATA_DIR) {
    $env:CODEX_WEBUI_DATA_DIR
  } elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "CodexWebUI"
  } else {
    Join-Path $HOME ".local/share/codex-webui"
  }
  New-Item -ItemType Directory -Force -Path $ResolvedDataDir | Out-Null
  $PidFile = Join-Path $ResolvedDataDir "codex-webui.pid"
  $LogFile = Join-Path $ResolvedDataDir "codex-webui.log"
  $ErrFile = Join-Path $ResolvedDataDir "codex-webui.err.log"

  $Listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($Listening -and $Restart) {
    $OwnerPids = @($Listening | Select-Object -ExpandProperty OwningProcess -Unique)
    $RecordedPid = if (Test-Path -LiteralPath $PidFile) {
      [int](Get-Content -LiteralPath $PidFile -Raw)
    } else {
      0
    }
    if ($OwnerPids.Count -ne 1 -or $RecordedPid -ne $OwnerPids[0]) {
      throw "Refusing to restart: port $Port is not owned by the recorded Codex WebUI process."
    }
    $ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $RecordedPid"
    if (!$ProcessInfo -or $ProcessInfo.Name -ne "node.exe") {
      throw "Refusing to restart: PID $RecordedPid is not a node process."
    }
    if ($ProcessInfo.CommandLine -and $ProcessInfo.CommandLine -notmatch "server[\\/]index\.js") {
      throw "Refusing to restart: PID $RecordedPid has a non-WebUI node command line."
    }
    & taskkill /pid $RecordedPid /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to stop the existing Codex WebUI process tree."
    }
    for ($Attempt = 0; $Attempt -lt 50; $Attempt++) {
      if (!(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 100
    }
    $Listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($Listening) { throw "Port $Port did not become available after restart." }
  }
  if ($Listening) {
    Set-Content -Path $PidFile -Value $Listening[0].OwningProcess -Encoding ascii
    Write-Host "Codex WebUI is already listening on port $Port."
  } else {
    $Process = Start-Process `
      -FilePath "node" `
      -ArgumentList "server/index.js" `
      -WorkingDirectory $ProjectRoot `
      -PassThru `
      -WindowStyle Hidden `
      -RedirectStandardOutput $LogFile `
      -RedirectStandardError $ErrFile
    Set-Content -Path $PidFile -Value $Process.Id -Encoding ascii
    Write-Host "Started Codex WebUI (PID $($Process.Id))."
  }

  if (!$NoQr) {
    $FirstToken = (node scripts/token-manager.js list --json | ConvertFrom-Json | Where-Object { $_.disabled -eq $false } | Select-Object -First 1)
    if ($FirstToken) {
      node scripts/token-manager.js qr $FirstToken.id
    }
  }
  Write-Host "Logs: $LogFile"
} finally {
  Pop-Location
}
