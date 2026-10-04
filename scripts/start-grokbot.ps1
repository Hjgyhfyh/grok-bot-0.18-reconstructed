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

# Keep every Cursor-side dependency switched off. Without these the app calls
# api2.cursor.sh and metrics.cursor.sh on every start and every turn, which
# both leaks usage anonymously and stalls on a timeout when unreachable.
$env:SAND_DISABLE_TELEMETRY = '1'
$env:SAND_DISABLE_ANALYTICS = '1'
$env:SAND_DISABLE_SENTRY = '1'
$env:SAND_CONVERSATION_GC = '1'
$env:SAND_RETIRE_LEGACY_STORE_BLOBS = '1'

# ---------------------------------------------------------------- local box ---
# The agents do not live in this process. They live and run on a "box", reached
# over the gateway below. Without this the desktop has no host to talk to and
# reports "Can't reach your computer".
#
# The gateway stays on loopback and is protected by a bearer token. Do not bind
# it to 0.0.0.0: the token grants ~124 commands including setHostSettings,
# setBoxSecrets and deleteAgents, and it is stored in plain text.
$boxRoot = Join-Path $env:LOCALAPPDATA 'GrokBotLocalBox'
$gatewayPort = 8790
$gatewayToken = 'grok-local-box-token-abc123'
$hostCjs = Join-Path $repoRoot '.build\fidelity\app\dist\host\host-main.cjs'

function Get-GatewayOwner {
    Get-NetTCPConnection -LocalPort $gatewayPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty OwningProcess
}

if (Test-Path -LiteralPath $hostCjs) {
    $existing = Get-GatewayOwner
    if ($existing) {
        Write-Host "box        : already running (pid $existing)"
    } else {
        # A stale lock from an unclean shutdown would make the next start fail.
        Remove-Item (Join-Path $boxRoot 'host.lock') -Force -ErrorAction SilentlyContinue
        # The host reads its secrets from the box store, not from the environment:
        # process.env does not survive the hand-off into the agent worker.
        $boxSecretStore = Join-Path $boxRoot 'box-secrets.json'
        $boxSecrets = [ordered]@{ version = 1; secrets = [ordered]@{} }
        foreach ($name in $secrets.Keys) { $boxSecrets.secrets[$name] = $secrets[$name] }
        New-Item -ItemType Directory -Path $boxRoot -Force | Out-Null
        [System.IO.File]::WriteAllText(
            $boxSecretStore,
            ($boxSecrets | ConvertTo-Json -Depth 6),
            (New-Object System.Text.UTF8Encoding($false)))

        # `cmd /c` is used because Start-Process -RedirectStandardOutput fails on
        # this machine ("Item has already been added. Key in dictionary: NO_PROXY").
        $env:SAND_GATEWAY_BIND_HOST = '127.0.0.1'
        $env:SAND_HOST_PORT = "$gatewayPort"
        $env:SAND_GATEWAY_TOKEN = $gatewayToken
        $env:SAND_DATA_ROOT = $boxRoot
        $env:SAND_USER_DATA_DIR = $boxRoot
        $logFile = Join-Path $boxRoot 'box.log'
        $cmdline = 'node "{0}" > "{1}" 2>&1' -f $hostCjs, $logFile
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmdline -WindowStyle Hidden | Out-Null
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            if (Get-GatewayOwner) { break }
        }
        $owner = Get-GatewayOwner
        if ($owner) {
            Write-Host "box        : started (pid $owner, http://127.0.0.1:$gatewayPort)"
        } else {
            Write-Warning "box failed to start -- see $logFile"
        }
    }
    # The desktop reads the token from a different variable than the host uses.
    $env:SAND_HOST_GATEWAY_URL = "http://127.0.0.1:$gatewayPort"
    $env:SAND_HOST_GATEWAY_TOKEN = $gatewayToken
} else {
    Write-Warning "box bundle not found: $hostCjs -- run: npm run package"
}

if ($Debug) {
    Write-Host "exe: $ExePath"
    Write-Host ("env: " + (($secrets.Keys | ForEach-Object { "$_=<set>" }) -join ' '))
}

Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path -Parent $ExePath) | Out-Null
Write-Host 'Grok Bot started.'