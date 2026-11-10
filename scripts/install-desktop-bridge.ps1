param(
  [string]$DataDir = "",
  [string]$WindowsNodePath = "",
  [switch]$Activate,
  [switch]$Disable
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "PowerShell 7 or newer is required. Run this installer with pwsh, not Windows PowerShell 5.1."
}
if ($Activate -and $Disable) {
  throw "Use either -Activate or -Disable, not both."
}

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ResolvedDataDir = if ($DataDir) {
  [System.IO.Path]::GetFullPath($DataDir)
} elseif ($env:CODEX_WEBUI_DATA_DIR) {
  [System.IO.Path]::GetFullPath($env:CODEX_WEBUI_DATA_DIR)
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA "CodexWebUI"
} else {
  throw "LOCALAPPDATA is unavailable; pass -DataDir explicitly."
}
$BridgeDir = Join-Path $ResolvedDataDir "desktop-bridge"
$RuntimeDir = Join-Path $BridgeDir "runtime"
$InstallDir = Join-Path $RuntimeDir "windows-v3"
$LauncherPath = Join-Path $InstallDir "codex-webui-bridge.exe"
$ConfigPath = Join-Path $InstallDir "codex-webui-bridge.config"
$ActivationStatePath = Join-Path $RuntimeDir "activation-state.json"
$EnabledMarkerPath = Join-Path $BridgeDir "enabled"

function Send-EnvironmentChanged {
  if (!("CodexWebUI.EnvironmentBroadcast" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace CodexWebUI {
  public static class EnvironmentBroadcast {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
      IntPtr hWnd, uint msg, UIntPtr wParam, string lParam,
      uint flags, uint timeout, out UIntPtr result);
  }
}
"@
  }
  $Result = [UIntPtr]::Zero
  [void][CodexWebUI.EnvironmentBroadcast]::SendMessageTimeout(
    [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 0x0002, 5000, [ref]$Result
  )
}

function Test-SamePath {
  param([string]$Left, [string]$Right)
  if (!$Left -or !$Right) { return $false }
  try {
    return [System.IO.Path]::GetFullPath($Left) -eq [System.IO.Path]::GetFullPath($Right)
  } catch {
    return $false
  }
}

if ($Disable) {
  $Current = [Environment]::GetEnvironmentVariable("CODEX_CLI_PATH", "User")
  if (Test-Path -LiteralPath $EnabledMarkerPath) {
    Remove-Item -LiteralPath $EnabledMarkerPath -Force
  }
  if (Test-SamePath $Current $LauncherPath) {
    $Previous = $null
    if (Test-Path -LiteralPath $ActivationStatePath) {
      $State = Get-Content -LiteralPath $ActivationStatePath -Raw | ConvertFrom-Json
      $Previous = [string]$State.previousCodexCliPath
    }
    [Environment]::SetEnvironmentVariable("CODEX_CLI_PATH", $(if ($Previous) { $Previous } else { $null }), "User")
    Send-EnvironmentChanged
    Write-Host "Desktop bridge disabled. Restart Codex Desktop to apply the restored setting."
  } else {
    Write-Host "Desktop bridge was not the active user CODEX_CLI_PATH; nothing changed."
  }
  return
}

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
$NodeCandidates = @(
  $(if ($WindowsNodePath) { [System.IO.Path]::GetFullPath($WindowsNodePath) }),
  $(if ($NodeCommand) { $NodeCommand.Source }),
  $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles "nodejs\node.exe" }),
  $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe" })
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$NodePath = $NodeCandidates | Select-Object -First 1
if (!$NodePath) {
  throw "Windows Node.js was not found. Install Node.js 22.13.0 or newer, or pass -WindowsNodePath explicitly."
}
$NodeVersionText = (& $NodePath -p "process.versions.node" | Out-String).Trim()
$NodeVersion = $null
if ($LASTEXITCODE -ne 0 -or ![version]::TryParse($NodeVersionText, [ref]$NodeVersion) -or $NodeVersion -lt [version]"22.13.0") {
  throw "Windows Node.js 22.13.0 or newer is required; found $NodeVersionText."
}

$BrokerPath = Join-Path $ProjectRoot "server\desktop-broker.js"
if (!(Test-Path -LiteralPath $BrokerPath)) {
  throw "Desktop bridge broker was not found: $BrokerPath"
}
$CompilerCandidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$Compiler = $CompilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!$Compiler) {
  throw ".NET Framework C# compiler was not found."
}

$StagingDir = Join-Path $RuntimeDir (".install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null
try {
  $StagingLauncher = Join-Path $StagingDir "codex-webui-bridge.exe"
  $StagingConfig = Join-Path $StagingDir "codex-webui-bridge.config"
  & $Compiler /nologo /target:exe /r:System.Management.dll "/out:$StagingLauncher" (Join-Path $ProjectRoot "desktop-bridge\launcher.cs") (Join-Path $ProjectRoot "desktop-bridge\pipe-client.cs")
  if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $StagingLauncher)) {
    throw "Desktop bridge launcher compilation failed."
  }
  $ConfigLines = @("version=3", $NodePath, $BrokerPath, $ProjectRoot, $ResolvedDataDir)
  [System.IO.File]::WriteAllLines($StagingConfig, $ConfigLines, [System.Text.UTF8Encoding]::new($false))

  $AlreadyInstalled = (Test-Path -LiteralPath $LauncherPath) -and
    (Test-Path -LiteralPath $ConfigPath) -and
    ((Get-FileHash -LiteralPath $LauncherPath).Hash -eq (Get-FileHash -LiteralPath $StagingLauncher).Hash) -and
    ((Get-FileHash -LiteralPath $ConfigPath).Hash -eq (Get-FileHash -LiteralPath $StagingConfig).Hash)
  if (!$AlreadyInstalled) {
    $InstallInUse = Get-CimInstance Win32_Process -Filter "Name = 'codex-webui-bridge.exe'" -ErrorAction SilentlyContinue |
      Where-Object { Test-SamePath $_.ExecutablePath $LauncherPath } |
      Select-Object -First 1
    if ($InstallInUse) {
      throw "The installed Windows bridge is currently in use and differs from this build. Exit Codex Desktop, then run the installer again."
    }
    if (Test-Path -LiteralPath $InstallDir) {
      Remove-Item -LiteralPath $InstallDir -Recurse -Force
    }
    Move-Item -LiteralPath $StagingDir -Destination $InstallDir
  }
} finally {
  if (Test-Path -LiteralPath $StagingDir) {
    Remove-Item -LiteralPath $StagingDir -Recurse -Force
  }
}

Write-Host "Windows Desktop bridge installed: $LauncherPath"
Write-Host "Windows adapter: Node $(& $NodePath --version) ($NodePath)"
if (!$Activate) {
  Write-Host "Not activated. Re-run with -Activate only when it is safe to restart Codex Desktop."
  return
}

$Previous = [Environment]::GetEnvironmentVariable("CODEX_CLI_PATH", "User")
if (Test-SamePath $Previous $LauncherPath) {
  Set-Content -LiteralPath $EnabledMarkerPath -Value "desktop" -Encoding ascii
  Send-EnvironmentChanged
  Write-Host "Desktop bridge is already active. Restart Codex Desktop if it is still using a previous process."
  return
}
@{
  previousCodexCliPath = $Previous
  activatedAt = [DateTime]::UtcNow.ToString("o")
  launcherPath = $LauncherPath
} | ConvertTo-Json | Set-Content -LiteralPath $ActivationStatePath -Encoding utf8
[Environment]::SetEnvironmentVariable("CODEX_CLI_PATH", $LauncherPath, "User")
Set-Content -LiteralPath $EnabledMarkerPath -Value "desktop" -Encoding ascii
Send-EnvironmentChanged
Write-Host "Desktop bridge activated for future Codex Desktop launches. Restart Codex Desktop when ready."
