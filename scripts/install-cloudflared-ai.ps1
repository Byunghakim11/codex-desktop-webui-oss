[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
  [string]$ExpectedTunnelId,
  [string]$CloudflaredPath = "",
  [string]$RuntimeDir = "",
  [string]$TokenSourceFile = "",
  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ServiceName = "CloudflaredAI"
$ProtectedServiceName = "Cloudflared"
$MinimumTokenFileVersion = [Version]"2025.4.0"
$ResolvedRuntimeDir = if ($RuntimeDir) {
  [System.IO.Path]::GetFullPath($RuntimeDir)
} elseif ($env:ProgramData) {
  Join-Path $env:ProgramData "cloudflared-ai"
} else {
  throw "ProgramData is unavailable; pass -RuntimeDir explicitly."
}
$TokenPath = Join-Path $ResolvedRuntimeDir "token"
$LogPath = Join-Path $ResolvedRuntimeDir "cloudflared-ai.log"

function Test-IsAdministrator {
  $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
  return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-CloudflaredExecutable {
  param([string]$RequestedPath)

  $Candidates = @()
  if ($RequestedPath) { $Candidates += [System.IO.Path]::GetFullPath($RequestedPath) }
  $Command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if ($Command -and $Command.Source) { $Candidates += $Command.Source }
  $Candidates += "C:\Program Files (x86)\cloudflared\cloudflared.exe"
  $Candidates += "C:\Program Files\cloudflared\cloudflared.exe"

  $Resolved = $Candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -First 1
  if (!$Resolved) {
    throw "cloudflared.exe was not found. Install the official Cloudflare package first."
  }
  return [System.IO.Path]::GetFullPath($Resolved)
}

function Get-CloudflaredVersion {
  param([string]$ExecutablePath)

  $Output = (& $ExecutablePath --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $Output -notmatch 'version\s+(\d+\.\d+\.\d+)') {
    throw "Unable to verify the cloudflared version at $ExecutablePath."
  }
  return [Version]$Matches[1]
}

function Assert-CloudflareSignature {
  param([string]$ExecutablePath)

  $Signature = Get-AuthenticodeSignature -LiteralPath $ExecutablePath
  $Signer = if ($Signature.SignerCertificate) { $Signature.SignerCertificate.Subject } else { "" }
  if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $Signer -notmatch 'Cloudflare, Inc\.') {
    throw "cloudflared.exe does not have a valid Cloudflare, Inc. Authenticode signature."
  }
  return $Signer
}

function ConvertFrom-Base64Url {
  param([string]$Value)

  $Normalized = $Value.Trim().Replace('-', '+').Replace('_', '/')
  switch ($Normalized.Length % 4) {
    0 { }
    2 { $Normalized += "==" }
    3 { $Normalized += "=" }
    default { throw "The tunnel token is not valid base64 data." }
  }
  return [Convert]::FromBase64String($Normalized)
}

function Get-TunnelIdFromToken {
  param([string]$Token)

  if ([string]::IsNullOrWhiteSpace($Token) -or $Token -match '\s') {
    throw "The tunnel token is empty or contains whitespace."
  }
  try {
    $Json = [Text.Encoding]::UTF8.GetString((ConvertFrom-Base64Url -Value $Token))
    $Payload = $Json | ConvertFrom-Json
  } catch {
    throw "The supplied value is not a valid Cloudflare Tunnel token."
  }
  $TunnelId = [string]$Payload.t
  if ($TunnelId -notmatch '^[0-9a-fA-F-]{36}$') {
    throw "The Cloudflare Tunnel token does not contain a valid tunnel ID."
  }
  return ([Guid]$TunnelId).ToString()
}

function Read-TunnelToken {
  param([string]$SourceFile)

  if ($SourceFile) {
    $ResolvedSource = (Resolve-Path -LiteralPath $SourceFile).Path
    return (Get-Content -LiteralPath $ResolvedSource -Raw).Trim()
  }
  $SecureToken = Read-Host "Paste the AI Tunnel token (input is hidden)" -AsSecureString
  $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureToken)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer)
  }
}

function Set-ProtectedDirectoryAcl {
  param([string]$Path)

  $SystemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $AdminsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $Inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $Propagation = [Security.AccessControl.PropagationFlags]::None
  $Allow = [Security.AccessControl.AccessControlType]::Allow
  $Acl = [Security.AccessControl.DirectorySecurity]::new()
  $Acl.SetAccessRuleProtection($true, $false)
  $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($SystemSid, 'FullControl', $Inheritance, $Propagation, $Allow))
  $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($AdminsSid, 'FullControl', $Inheritance, $Propagation, $Allow))
  [IO.Directory]::SetAccessControl($Path, $Acl)
}

function Set-ProtectedFileAcl {
  param([string]$Path)

  $SystemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $AdminsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $Allow = [Security.AccessControl.AccessControlType]::Allow
  $Acl = [Security.AccessControl.FileSecurity]::new()
  $Acl.SetAccessRuleProtection($true, $false)
  $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($SystemSid, 'FullControl', $Allow))
  $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($AdminsSid, 'FullControl', $Allow))
  [IO.File]::SetAccessControl($Path, $Acl)
}

function Get-ServiceSnapshot {
  param([string]$Name)

  $Service = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
  if (!$Service) { return $null }
  return [pscustomobject]@{
    Name = $Service.Name
    State = $Service.State
    StartMode = $Service.StartMode
    PathName = $Service.PathName
  }
}

function Quote-ServiceArgument {
  param([string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

$ResolvedCloudflared = Resolve-CloudflaredExecutable -RequestedPath $CloudflaredPath
$CloudflaredVersion = Get-CloudflaredVersion -ExecutablePath $ResolvedCloudflared
if ($CloudflaredVersion -lt $MinimumTokenFileVersion) {
  throw "cloudflared $CloudflaredVersion is too old for --token-file; version $MinimumTokenFileVersion or newer is required."
}
$Signer = Assert-CloudflareSignature -ExecutablePath $ResolvedCloudflared

$ExecutableArgument = Quote-ServiceArgument -Value $ResolvedCloudflared
$LogArgument = Quote-ServiceArgument -Value $LogPath
$TokenArgument = Quote-ServiceArgument -Value $TokenPath
$ExpectedServiceCommand = "$ExecutableArgument tunnel --no-autoupdate --loglevel info --logfile $LogArgument run --token-file $TokenArgument"
$ExistingAiService = Get-ServiceSnapshot -Name $ServiceName
if ($ExistingAiService) {
  $ExistingPath = [string]$ExistingAiService.PathName
  if ($ExistingPath -notlike "*$ResolvedCloudflared*" -or $ExistingPath -notlike "*--token-file*$TokenPath*") {
    throw "Refusing to reuse $ServiceName because its command does not belong to this installer."
  }
}

if ($ValidateOnly -or $WhatIfPreference) {
  [pscustomobject]@{
    Mode = if ($WhatIfPreference) { "WhatIf" } else { "ValidateOnly" }
    ServiceName = $ServiceName
    CloudflaredPath = $ResolvedCloudflared
    CloudflaredVersion = $CloudflaredVersion.ToString()
    SignatureVerified = $true
    RuntimeDir = $ResolvedRuntimeDir
    TokenPath = $TokenPath
    ExistingAiService = [bool]$ExistingAiService
    ProtectedService = $ProtectedServiceName
    PlannedCommand = $ExpectedServiceCommand
  } | Format-List
  return
}

if (!(Test-IsAdministrator)) {
  throw "Run this script from an Administrator PowerShell window."
}

$ProtectedBefore = Get-ServiceSnapshot -Name $ProtectedServiceName
$TunnelToken = Read-TunnelToken -SourceFile $TokenSourceFile
try {
  $TokenTunnelId = Get-TunnelIdFromToken -Token $TunnelToken
  $NormalizedExpectedId = ([Guid]$ExpectedTunnelId).ToString()
  if ($TokenTunnelId -ne $NormalizedExpectedId) {
    throw "The pasted token belongs to tunnel $TokenTunnelId, not the expected AI tunnel $NormalizedExpectedId. No token or service changes were made."
  }

  if ($PSCmdlet.ShouldProcess($ResolvedRuntimeDir, "Create protected CloudflaredAI runtime directory")) {
    New-Item -ItemType Directory -Force -Path $ResolvedRuntimeDir | Out-Null
    Set-ProtectedDirectoryAcl -Path $ResolvedRuntimeDir
    [IO.File]::WriteAllText($TokenPath, $TunnelToken, [Text.UTF8Encoding]::new($false))
    Set-ProtectedFileAcl -Path $TokenPath
  }
} finally {
  $TunnelToken = $null
}

if (!$ExistingAiService) {
  if ($PSCmdlet.ShouldProcess($ServiceName, "Create dedicated automatic Windows service")) {
    New-Service `
      -Name $ServiceName `
      -DisplayName "Cloudflared AI Tunnel" `
      -Description "Dedicated Cloudflare Tunnel connector for Codex WebUI; unrelated to the existing MCP connector." `
      -BinaryPathName $ExpectedServiceCommand `
      -StartupType Automatic | Out-Null
    & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Created $ServiceName, but failed to configure service recovery."
    }
  }
} else {
  Set-Service -Name $ServiceName -StartupType Automatic
}

if ($PSCmdlet.ShouldProcess($ServiceName, "Start or restart the dedicated AI tunnel connector")) {
  $CurrentAiService = Get-Service -Name $ServiceName
  if ($CurrentAiService.Status -eq 'Running') {
    Restart-Service -Name $ServiceName -Force
  } else {
    Start-Service -Name $ServiceName
  }
}

$Deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  $CurrentAiService = Get-Service -Name $ServiceName
} while ($CurrentAiService.Status -ne 'Running' -and [DateTime]::UtcNow -lt $Deadline)
if ($CurrentAiService.Status -ne 'Running') {
  throw "$ServiceName did not reach the Running state. Inspect $LogPath."
}

$ConnectorEvidenceFound = $false
do {
  if (Test-Path -LiteralPath $LogPath) {
    $ConnectorEvidenceFound = [bool](Select-String -LiteralPath $LogPath -Pattern 'Registered tunnel connection|Initial protocol' -Quiet)
  }
  if (!$ConnectorEvidenceFound) { Start-Sleep -Milliseconds 500 }
} while (!$ConnectorEvidenceFound -and [DateTime]::UtcNow -lt $Deadline)

$ProtectedAfter = Get-ServiceSnapshot -Name $ProtectedServiceName
$ProtectedUnchanged = if (!$ProtectedBefore -and !$ProtectedAfter) {
  $true
} elseif ($ProtectedBefore -and $ProtectedAfter) {
  $ProtectedBefore.PathName -eq $ProtectedAfter.PathName -and
    $ProtectedBefore.StartMode -eq $ProtectedAfter.StartMode -and
    $ProtectedBefore.State -eq $ProtectedAfter.State
} else {
  $false
}
if (!$ProtectedUnchanged) {
  throw "The protected $ProtectedServiceName service changed during installation. Stop and inspect both services before continuing."
}

[pscustomobject]@{
  ServiceName = $ServiceName
  Status = $CurrentAiService.Status
  TunnelId = ([Guid]$ExpectedTunnelId).ToString()
  CloudflaredVersion = $CloudflaredVersion.ToString()
  SignatureSigner = $Signer
  TokenStorage = $TokenPath
  LogPath = $LogPath
  ConnectorEvidenceFound = $ConnectorEvidenceFound
  ProtectedMcpServiceUnchanged = $ProtectedUnchanged
  NextStep = "Wait for the Cloudflare ai tunnel to show Healthy, then add the published application route."
} | Format-List
