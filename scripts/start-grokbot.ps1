#Requires -Version 5.1
<#
  Grok Bot - turnkey launcher (Windows).

  Decrypts the DPAPI-protected credentials in <sandRoot>\launcher-secrets.txt and
  launches the packaged app with them in the environment. The credentials are
  never written in plaintext and never leave this Windows user account.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\start-grokbot.ps1
    powershell -ExecutionPolicy Bypass -File scripts\start-grokbot.ps1 -Debug
#>
# NOTE: no [CmdletBinding()] here. It injects the common -Debug parameter, which collides
# with the explicit [switch]$Debug below and makes every invocation die with
# "A parameter with the name 'Debug' was defined multiple times". Declaring the parameter
# by hand is what the help text above documents.
param(
    [switch]$Debug,
    [string]$ExePath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ExePath) {
    $ExePath = Join-Path $repoRoot 'dist\Grok Bot 0.18 Reconstructed\Grok Bot.exe'
}
if (-not (Test-Path -LiteralPath $ExePath)) {
    throw "Packaged app not found: $ExePath -- run: npm run package"
}

$secretFile = Join-Path $env:USERPROFILE '.grokbot\launcher-secrets.txt'

function Read-DpapiSecrets {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $map }
    foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $parts = $line.Split('=', 2)
        $name = $parts[0].Trim()
        $blob = $parts[1].Trim()
        try {
            $secure = ConvertTo-SecureString -String $blob
            $map[$name] = [Net.NetworkCredential]::new('', $secure).Password
        } catch {
            Write-Warning "Could not decrypt $name - it belongs to a different Windows user."
        }
    }
    return $map
}

$secrets = Read-DpapiSecrets -Path $secretFile
foreach ($name in $secrets.Keys) {
    [Environment]::SetEnvironmentVariable($name, $secrets[$name], 'Process')
}

if ($secrets.ContainsKey('OPENAI_COMPATIBLE_API_KEY')) {
    Write-Host 'inference  : opencode-go (https://opencode.ai/zen/go/v1)'
}
if ($secrets.ContainsKey('TYPESAFE_API_KEY')) {
    Write-Host 'classifier : Jev (https://api.typesafe.ai/v1)'
}

# The packaged build already bakes this in; set it again so a hand-edited
# build cannot re-enable an update path that bricks an unpacked app.
$env:SAND_DISABLE_UPDATES = '1'

if ($Debug) {
    Write-Host "exe: $ExePath"
    Write-Host ("env: " + (($secrets.Keys | ForEach-Object { "$_=<set>" }) -join ' '))
}

Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path -Parent $ExePath) | Out-Null
Write-Host 'Grok Bot started.'