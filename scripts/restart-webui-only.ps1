[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$ExpectedPid,
  [int]$ExpectedParentPid = 0,
  [int]$Port = 9526,
  [string]$HostAddress = "127.0.0.1",
  [string]$DataDir = "",
  [switch]$FileConfigurationVerified,
  [switch]$PlanOnly
)

# Restarts ONLY the Codex WebUI node process that already owns $Port.
# Desktop, the desktop broker and the Codex app-server engine are never stopped,
# restarted, reconfigured or otherwise touched by this helper.

$ErrorActionPreference = "Stop"

function Fail([string]$Code, [string]$Message) {
  throw ("WEBUI-RESTART-ERROR|" + $Code + "|" + $Message)
}

function Get-NormalizedPath([string]$PathValue) {
  $full = [System.IO.Path]::GetFullPath($PathValue)
  if ($full.Length -gt 3) { $full = $full.TrimEnd([char]'\', [char]'/') }
  return $full
}

function Get-CommandLineTokens([string]$CommandLine) {
  $tokens = New-Object System.Collections.Generic.List[string]
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return ,$tokens.ToArray() }
  foreach ($match in ([regex]'("([^"]*)"|(\S+))').Matches($CommandLine)) {
    if ($match.Groups[2].Success) { [void]$tokens.Add($match.Groups[2].Value) }
    elseif ($match.Groups[3].Success) { [void]$tokens.Add($match.Groups[3].Value) }
  }
  return ,$tokens.ToArray()
}

function Get-NormalizedTokens([string]$CommandLine) {
  return @(Get-CommandLineTokens $CommandLine | ForEach-Object { $_ -replace '/', '\' })
}

function Test-ExactPathToken([string[]]$Tokens, [string]$PathValue) {
  $expected = $PathValue -replace '/', '\'
  $hits = @($Tokens | Where-Object { [string]::Equals($_, $expected, [System.StringComparison]::OrdinalIgnoreCase) })
  return $hits.Count
}

function Get-PortListeners([int]$PortNumber) {
  return @(Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue)
}

function Get-PortOwnerIds([int]$PortNumber) {
  return @(Get-PortListeners $PortNumber | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Get-FileSha256([string]$PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) { return $null }
  return (Get-FileHash -LiteralPath $PathValue -Algorithm SHA256).Hash.ToLowerInvariant()
}

$script:OldPidStopped = $false
$script:NewPid = $null
$script:OutLog = $null
$script:ErrLog = $null

try {
  if ($ExpectedPid -le 0) { Fail "invalid-expected-pid" "-ExpectedPid must be a positive integer." }
  if ($ExpectedParentPid -lt 0) { Fail "invalid-expected-parent-pid" "-ExpectedParentPid must be zero or a positive integer." }
  if ($Port -lt 1 -or $Port -gt 65535) { Fail "invalid-port" "-Port must be between 1 and 65535." }
  if ([string]::IsNullOrWhiteSpace($HostAddress)) { Fail "invalid-host" "-HostAddress must not be empty." }

  $ProjectRoot = Get-NormalizedPath (Join-Path $PSScriptRoot "..")
  $IndexPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "server/index.js"))
  if (-not (Test-Path -LiteralPath $IndexPath -PathType Leaf)) {
    Fail "index-source-missing" "The expected WebUI entry point server/index.js is not present in this project root."
  }

  if ([string]::IsNullOrWhiteSpace($DataDir)) {
    if ($env:LOCALAPPDATA) { $DataDir = Join-Path $env:LOCALAPPDATA "CodexWebUI" }
    else { $DataDir = Join-Path $HOME ".local/share/codex-webui" }
  }
  $DataDir = Get-NormalizedPath $DataDir
  if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
    Fail "data-dir-missing" "The WebUI data directory does not exist; refusing to start a WebUI without its existing state."
  }
  $PidFile = Join-Path $DataDir "codex-webui.pid"
  $SecretDir = Join-Path $DataDir "desktop-bridge"
  $SecretPath = Join-Path $SecretDir "secret"

  # Guard 1: exactly one unique listener on the port and it must be ExpectedPid.
  $ownerIds = @(Get-PortOwnerIds $Port)
  if ($ownerIds.Count -eq 0) { Fail "no-listener" "No process is listening on port $Port; refusing to start a second untracked WebUI." }
  if ($ownerIds.Count -ne 1) { Fail "multiple-port-owners" "Port $Port has more than one listening owner; refusing to touch it." }
  $PortOwnerPid = [int]$ownerIds[0]
  if ($PortOwnerPid -ne $ExpectedPid) { Fail "port-owner-mismatch" "Port $Port is owned by a different process than -ExpectedPid; refusing to stop an unexpected port owner." }

  # Guard 2: the recorded process must be node.exe with an existing, trusted executable.
  $oldProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ExpectedPid" -ErrorAction SilentlyContinue
  if (-not $oldProcess) { Fail "process-missing" "The expected WebUI process is not running." }
  if ([string]$oldProcess.Name -ne "node.exe") { Fail "not-node-process" "The port owner is not a node.exe process; refusing to continue." }
  $NodeExecutable = [string]$oldProcess.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($NodeExecutable)) { Fail "node-executable-missing" "The running WebUI process does not expose an executable path." }
  $NodeExecutable = [System.IO.Path]::GetFullPath($NodeExecutable)
  if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { Fail "node-executable-missing" "The node executable used by the running WebUI is no longer present." }
  if ([System.IO.Path]::GetFileName($NodeExecutable) -ine "node.exe") { Fail "node-executable-untrusted" "The running WebUI executable is not node.exe; refusing to reuse it." }
  $nodeVersionInfo = (Get-Item -LiteralPath $NodeExecutable).VersionInfo
  $trustedNode = ($nodeVersionInfo.ProductName -like "*Node.js*") -or ($nodeVersionInfo.OriginalFilename -ieq "node.exe") -or ($nodeVersionInfo.FileDescription -like "*Node.js*")
  if (-not $trustedNode) { Fail "node-executable-untrusted" "The running WebUI executable is not a verified Node.js binary; refusing to reuse it." }

  # Guard 3: the command line must carry this project's absolute server/index.js argument.
  $oldTokens = @(Get-NormalizedTokens ([string]$oldProcess.CommandLine))
  if ($oldTokens.Count -lt 2) { Fail "cmdline-unavailable" "The command line of the recorded process is not inspectable; refusing to stop it." }
  $normalizedIndex = $IndexPath -replace '/', '\'
  $indexTokens = @($oldTokens | Where-Object { $_ -match '(?i)(^|\\)server\\index\.js$' })
  if ($indexTokens.Count -eq 0) { Fail "index-argument-missing" "The recorded process was not started from a server\index.js entry point; refusing to touch it." }
  if ($indexTokens.Count -ne 1) { Fail "index-argument-foreign" "The recorded process has ambiguous server\index.js arguments; refusing to touch it." }
  if (-not [string]::Equals($indexTokens[0], $normalizedIndex, [System.StringComparison]::OrdinalIgnoreCase)) {
    Fail "index-argument-foreign" "The recorded process runs a server\index.js from a different installation than this project; refusing to touch it."
  }

  # Guard 4: managed handoff (explicit broker parent) or manual mode (recorded PID file).
  $ParentBrokerPid = $null
  $RecordedPid = $null
  if ($ExpectedParentPid -gt 0) {
    if ([int]$oldProcess.ParentProcessId -ne $ExpectedParentPid) {
      Fail "parent-mismatch" "The recorded WebUI's parent process is not -ExpectedParentPid; refusing to assume a managed handoff."
    }
    $parentProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ExpectedParentPid" -ErrorAction SilentlyContinue
    if (-not $parentProcess) { Fail "parent-missing" "The declared parent process is not running." }
    if ([string]$parentProcess.Name -ne "node.exe") { Fail "parent-not-node" "The declared parent process is not node.exe; refusing to assume a managed handoff." }
    $BrokerPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "server/desktop-broker.js"))
    $parentTokens = @(Get-NormalizedTokens ([string]$parentProcess.CommandLine))
    if ((Test-ExactPathToken $parentTokens $BrokerPath) -ne 1) {
      Fail "parent-not-broker" "The declared parent process is not this project's desktop-broker.js; refusing to assume a managed handoff."
    }
    $ParentBrokerPid = [int]$ExpectedParentPid
    $Mode = "managed-handoff"
  } else {
    if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
      Fail "pidfile-missing" "Manual mode requires an existing codex-webui.pid in the data directory that records -ExpectedPid."
    }
    try { $RecordedPid = [int]((Get-Content -LiteralPath $PidFile -Raw).Trim()) }
    catch { Fail "pidfile-unreadable" "The existing codex-webui.pid could not be parsed as a process id." }
    if ($RecordedPid -ne $ExpectedPid) {
      Fail "pidfile-mismatch" "The recorded codex-webui.pid does not match -ExpectedPid; refusing to stop an untracked process."
    }
    $Mode = "manual-shared-engine"
  }

  # Guard 5: existing Desktop bridge secret must exist. It is only probed, never read,
  # copied or rewritten, so this helper cannot mint a new bridge identity or sign-in.
  if (-not (Test-Path -LiteralPath $SecretPath -PathType Leaf)) {
    Fail "bridge-secret-missing" "No existing Desktop bridge secret in the data directory; refusing to start a WebUI without the established bridge identity."
  }

  $IndexSha256 = Get-FileSha256 $IndexPath
  $AppJsPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "public/app.js"))
  $AppJsSha256 = Get-FileSha256 $AppJsPath
  $seed = "index.js:" + [string]$IndexSha256 + "`napp.js:" + [string]$AppJsSha256
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $sourceBuildhash = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($seed))).Replace("-", "").ToLowerInvariant()
  } finally { $sha.Dispose() }

  $stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
  $suffix = [System.Guid]::NewGuid().ToString("N").Substring(0, 8)
  $OutLog = Join-Path $DataDir ("codex-webui." + $stamp + "." + $suffix + ".out.log")
  $ErrLog = Join-Path $DataDir ("codex-webui." + $stamp + "." + $suffix + ".err.log")
  $ManifestPath = Join-Path $DataDir ("codex-webui.restart-manifest." + $stamp + "." + $suffix + ".json")
  $script:OutLog = $OutLog
  $script:ErrLog = $ErrLog

  $plan = [ordered]@{
    ok = $true
    planOnly = [bool]$PlanOnly
    mode = $Mode
    oldPid = [int]$ExpectedPid
    parentBrokerPid = $ParentBrokerPid
    port = [int]$Port
    hostAddress = $HostAddress
    dataDir = $DataDir
    projectRoot = $ProjectRoot
    indexPath = $IndexPath
    nodeExecutable = $NodeExecutable
    indexSha256 = $IndexSha256
    appJsSha256 = $AppJsSha256
    sourceBuildhash = $sourceBuildhash
    bridgeSecretPresent = $true
    pidFilePid = $RecordedPid
    preserved = [ordered]@{ desktop = $true; broker = $true; codexEngine = $true }
    wouldRun = [ordered]@{
      stopPid = [int]$ExpectedPid
      startExecutable = $NodeExecutable
      startArguments = @('"' + $IndexPath + '"')
      workingDirectory = $ProjectRoot
      environment = [ordered]@{ HOST = $HostAddress; PORT = [string]$Port; CODEX_WEBUI_DATA_DIR = $DataDir }
      pidFile = $PidFile
      stdoutLog = $OutLog
      stderrLog = $ErrLog
      manifestFile = $ManifestPath
    }
    mutations = @()
  }

  if ($PlanOnly) {
    $plan | ConvertTo-Json -Depth 6 -Compress
    exit 0
  }

  # This helper cannot recover another process's environment. Its supported live
  # contract is an explicitly verified file-token/default-pipe configuration.
  # The operator must first prove the existing token and default bridge work.
  if (-not $FileConfigurationVerified) { Fail "environment-unverified" "Verify file-based authentication and the default Desktop bridge, then pass -FileConfigurationVerified. The old process was preserved." }
  $overrideNames = @('CODEX_WEBUI_TOKEN','CODEX_WEBUI_TOKEN_SCOPES','CODEX_WEBUI_THREAD_FILTER_CWD','CODEX_WEBUI_CWD','CODEX_DESKTOP_BRIDGE_PIPE')
  foreach ($name in $overrideNames) {
    if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name,'Process'))) { Fail "environment-override" "The calling environment contains an unsupported WebUI override. No process was stopped." }
  }

  # Stop ONLY the recorded WebUI process. No taskkill, no tree kill, no -Name filters.
  try { Stop-Process -Id $ExpectedPid -ErrorAction Stop }
  catch { Fail "stop-failed" "The recorded WebUI process could not be stopped; nothing else was touched." }
  $script:OldPidStopped = $true

  $freeDeadline = (Get-Date).AddSeconds(5)
  $portFree = $false
  while ((Get-Date) -lt $freeDeadline) {
    if ((Get-PortOwnerIds $Port).Count -eq 0) { $portFree = $true; break }
    Start-Sleep -Milliseconds 100
  }
  if (-not $portFree) {
    Fail "port-not-released" ("The previous WebUI did not release port " + $Port + " within 5 seconds. No new process was started.")
  }

  # Environment changes apply to this helper process (and hence the child) only.
  $env:HOST = $HostAddress
  $env:PORT = [string]$Port
  $env:CODEX_WEBUI_DATA_DIR = $DataDir

  $startArguments = @('"' + $IndexPath + '"')
  $newProcess = Start-Process -FilePath $NodeExecutable -ArgumentList $startArguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
  $script:NewPid = [int]$newProcess.Id

  $verifyDeadline = (Get-Date).AddSeconds(15)
  $verified = $false
  while ((Get-Date) -lt $verifyDeadline) {
    if ($newProcess.HasExited) { break }
    $owners = @(Get-PortOwnerIds $Port)
    if ($owners.Count -eq 1 -and [int]$owners[0] -eq $script:NewPid) { $verified = $true; break }
    Start-Sleep -Milliseconds 200
  }
  if (-not $verified) {
    Fail "new-pid-not-listening" ("The new WebUI process (PID " + $script:NewPid + ") did not own port " + $Port + " within 15 seconds. No other process was stopped or started.")
  }

  $pidBackupName = $null
  if (Test-Path -LiteralPath $PidFile -PathType Leaf) {
    $pidBackupPath = Join-Path $DataDir ("codex-webui.pid.bak." + $stamp + "." + $suffix)
    Copy-Item -LiteralPath $PidFile -Destination $pidBackupPath -Force
    $pidBackupName = [System.IO.Path]::GetFileName($pidBackupPath)
  }
  Set-Content -LiteralPath $PidFile -Value ([string]$script:NewPid) -Encoding ascii -Force

  $manifest = [ordered]@{
    newPID = [int]$script:NewPid
    oldPID = [int]$ExpectedPid
    port = [int]$Port
    mode = $Mode
    sourceBuildhash = $sourceBuildhash
    parentBrokerPreserved = $true
    createdAt = (Get-Date).ToString("o")
    indexPath = $IndexPath
    hostAddress = $HostAddress
    dataDir = $DataDir
    stdoutLog = [System.IO.Path]::GetFileName($OutLog)
    stderrLog = [System.IO.Path]::GetFileName($ErrLog)
  }
  [System.IO.File]::WriteAllText($ManifestPath, ($manifest | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
  $manifestAclRestricted = $false
  try {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $ManifestPath -AclObject $acl
    $manifestAclRestricted = $true
  } catch { $manifestAclRestricted = $false }

  $result = [ordered]@{
    ok = $true
    planOnly = $false
    mode = $Mode
    oldPid = [int]$ExpectedPid
    newPid = [int]$script:NewPid
    parentBrokerPid = $ParentBrokerPid
    port = [int]$Port
    hostAddress = $HostAddress
    dataDir = $DataDir
    indexPath = $IndexPath
    nodeExecutable = $NodeExecutable
    sourceBuildhash = $sourceBuildhash
    pidFile = [System.IO.Path]::GetFileName($PidFile)
    pidFileBackup = $pidBackupName
    manifestFile = [System.IO.Path]::GetFileName($ManifestPath)
    manifestAclRestricted = $manifestAclRestricted
    stdoutLog = [System.IO.Path]::GetFileName($OutLog)
    stderrLog = [System.IO.Path]::GetFileName($ErrLog)
    preserved = [ordered]@{ desktop = $true; broker = ($ParentBrokerPid -ne $null); codexEngine = $true }
    note = "The restarted WebUI is a supported manual service tracked by its PID file, log files and launch manifest. Desktop, broker and Codex engine processes were not stopped or restarted."
  }
  $result | ConvertTo-Json -Depth 6 -Compress
  exit 0
} catch {
  $code = "unexpected-failure"
  $safeMessage = "The restart helper aborted before completing; internal details are withheld."
  $raw = [string]$_.Exception.Message
  if ($raw.StartsWith("WEBUI-RESTART-ERROR|")) {
    $parts = $raw.Split("|", 3)
    $code = $parts[1]
    if ($parts.Count -ge 3) { $safeMessage = $parts[2] }
  }
  $errorSummary = [ordered]@{
    ok = $false
    planOnly = [bool]$PlanOnly
    code = $code
    error = $safeMessage
    oldPid = [int]$ExpectedPid
    oldPidStopped = [bool]$script:OldPidStopped
    newPid = $script:NewPid
    stdoutLog = if ($script:OutLog) { [System.IO.Path]::GetFileName($script:OutLog) } else { $null }
    stderrLog = if ($script:ErrLog) { [System.IO.Path]::GetFileName($script:ErrLog) } else { $null }
    rollbackAttempted = $false
    note = "No rollback was attempted. Restore the source backup and start the old server manually if needed."
  }
  $errorSummary | ConvertTo-Json -Depth 4 -Compress
  exit 2
}
