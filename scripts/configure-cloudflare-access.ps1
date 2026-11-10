[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https://')]
  [string]$PublicUrl,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[^@\s]+@[^@\s]+$')]
  [string]$AllowedEmail,
  [string]$DataDir = "",
  [string]$TokenScopeId = "",
  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ResolvedDataDir = if ($DataDir) {
  [IO.Path]::GetFullPath($DataDir)
} elseif ($env:CODEX_WEBUI_DATA_DIR) {
  [IO.Path]::GetFullPath($env:CODEX_WEBUI_DATA_DIR)
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA "CodexWebUI"
} else {
  throw "LOCALAPPDATA is unavailable; pass -DataDir explicitly."
}

function ConvertFrom-Base64Url {
  param([string]$Value)
  $Normalized = $Value.Replace('-', '+').Replace('_', '/')
  switch ($Normalized.Length % 4) {
    0 { }
    2 { $Normalized += "==" }
    3 { $Normalized += "=" }
    default { throw "Invalid Cloudflare Access metadata encoding." }
  }
  return [Convert]::FromBase64String($Normalized)
}

$Headers = (& curl.exe -sS -o NUL -D - --max-time 20 --max-redirs 0 $PublicUrl | Out-String)
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the Cloudflare Access redirect." }
$LocationMatch = [regex]::Match($Headers, '(?im)^location:\s*(\S+)\s*$')
if (!$LocationMatch.Success) { throw "The public URL did not return a Cloudflare Access login redirect." }
$LoginUri = [Uri]$LocationMatch.Groups[1].Value
if ($LoginUri.Host -notmatch '^[a-z0-9-]+\.cloudflareaccess\.com$') {
  throw "The login redirect is not a Cloudflare Access team domain."
}
$MetaMatch = [regex]::Match($LoginUri.Query, '(?:^|[?&])meta=([^&]+)')
if (!$MetaMatch.Success) { throw "The Cloudflare Access redirect did not contain application metadata." }
$MetaToken = [Uri]::UnescapeDataString($MetaMatch.Groups[1].Value)
$MetaParts = $MetaToken.Split('.')
if ($MetaParts.Count -ne 3) { throw "The Cloudflare Access metadata token is malformed." }
$Payload = [Text.Encoding]::UTF8.GetString((ConvertFrom-Base64Url -Value $MetaParts[1])) | ConvertFrom-Json
$Audience = [string]$Payload.aud
if (!$Audience) { throw "The Cloudflare Access application audience was not found." }

$Config = [ordered]@{
  teamDomain = $LoginUri.Host.ToLowerInvariant()
  audience = $Audience
  allowedEmails = @($AllowedEmail.Trim().ToLowerInvariant())
}
if ($TokenScopeId) { $Config.tokenScopeId = $TokenScopeId.Trim() }
$ConfigPath = Join-Path $ResolvedDataDir "cloudflare-access.json"

if (!$ValidateOnly) {
  New-Item -ItemType Directory -Force -Path $ResolvedDataDir | Out-Null
  [IO.File]::WriteAllText(
    $ConfigPath,
    (($Config | ConvertTo-Json -Depth 3) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )
}

[pscustomobject]@{
  Mode = if ($ValidateOnly) { "ValidateOnly" } else { "Configured" }
  PublicUrl = $PublicUrl
  TeamDomain = $Config.teamDomain
  AudienceFingerprint = $Audience.Substring(0, [Math]::Min(12, $Audience.Length))
  AllowedEmail = $Config.allowedEmails[0]
  ConfigPath = $ConfigPath
  RestartRequired = !$ValidateOnly
} | Format-List
