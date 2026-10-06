#Requires -Version 5.1
<#
  Grok Bot - turnkey launcher (Windows).

  Decrypts the DPAPI-protected credentials in <userProfile>\.grokbot\launcher-secrets.txt and
  launches the packaged app with them in the environment.

  Credential exposure, stated plainly:
    * launcher-secrets.txt is DPAPI-protected and stays encrypted on disk.
    * box-secrets.json under %LOCALAPPDATA%\GrokBotLocalBox IS plaintext. The
      host reads its secrets from the box store, not from the environment,
      because process.env does not survive the hand-off into the agent worker,
      so the decryption below has to be written out. Its ACL is restricted to
      this user, SYSTEM and Administrators, but any process running as this
      user - including the agent itself - can read it. Do not treat it as a
      secret store against the agent.
    * The gateway bearer token is generated on first launch and kept in
      launcher-gateway-token.txt next to it. It is never a literal in this file.

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
# The gateway stays on loopback and is protected by a bearer token. The token
# grants ~124 commands including setHostSettings, setBoxSecrets and deleteAgents,
# so it must not be a value that anyone else already knows. It used to be a
# hardcoded literal on this line: a live probe with that string reached
# setBoxSecrets, deleteAgents, setHostSettings and sendPrompt and all four
# answered 200, because the literal travelled with the source.
$boxRoot = Join-Path $env:LOCALAPPDATA 'GrokBotLocalBox'
$gatewayPort = 8790
$hostCjs = Join-Path $repoRoot '.build\fidelity\app\dist\host\host-main.cjs'

function Get-GatewayOwner {
    Get-NetTCPConnection -LocalPort $gatewayPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty OwningProcess
}

# Is a box host alive right now, according to the lock it took?
#
# `Get-GatewayOwner` asks a different question - "is anything listening on
# 8790" - and the two answers disagree in the window that matters: a host that
# holds `host.lock` and has not bound its gateway yet. That window is real, not
# theoretical. On this host the box exec-daemon answers its first Ping only
# after it has spawned, and `host.start()` then brings up ~35 extensions before
# the gateway listens; `box.log` shows several seconds between the two. Ask the
# wrong question inside it and the answer is "not running" for a host that is
# mid-startup and about to serve.
#
# The lock file is the authority, because `acquireHostLock` is what wrote it and
# what reads it. The pid inside it is only believed when the process it names is
# a live `host-main`: a recycled pid must not read as a running box.
function Get-HostLockOwner {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $pid_ = $null
    try { $pid_ = [int]([System.IO.File]::ReadAllText($Path)).Trim() } catch { return $null }
    if (-not $pid_ -or $pid_ -le 0) { return $null }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pid_" -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return $null }
    if (-not $proc.CommandLine -or $proc.CommandLine -notlike '*host-main*') { return $null }
    return $pid_
}

# 32 bytes from the OS CSPRNG, base64url so the value survives an Authorization
# header unchanged.
function New-LocalBoxGatewayToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# Restrict a file to this user, SYSTEM and Administrators, with inheritance off.
# Best effort: a failure here warns and continues, because refusing to launch is
# worse than a wider ACL on a file that already had one.
function Protect-LocalBoxSecretFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $acl = Get-Acl -LiteralPath $Path
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
        $identities = @(
            [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
            (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')),
            (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544'))
        )
        foreach ($sid in $identities) {
            $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                $sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
                [System.Security.AccessControl.AccessControlType]::Allow)))
        }
        Set-Acl -LiteralPath $Path -AclObject $acl
    } catch {
        Write-Warning "Could not restrict the ACL on $Path - it keeps the ACL it already had."
    }
}

function Save-LocalBoxGatewayToken {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Token
    )
    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    [System.IO.File]::WriteAllText($Path, $Token, (New-Object System.Text.UTF8Encoding($false)))
    Protect-LocalBoxSecretFile -Path $Path
    return $Token
}

function Get-StoredGatewayToken {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $value = ([System.IO.File]::ReadAllText($Path)).Trim()
    } catch {
        return $null
    }
    # 32 bytes in base64url is 43 characters. Anything shorter was truncated or
    # hand-edited, and treating it as a token would only produce 401s later.
    if ($value.Length -lt 32) { return $null }
    return $value
}

# The running host republishes its token into gateway.json. When a box is
# already listening, adopting that token is the only way the desktop and the
# host agree; minting a new one here would give every command a 401.
function Get-RunningGatewayToken {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $parsed = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json
        $value = [string]$parsed.token
    } catch {
        return $null
    }
    $value = $value.Trim()
    if ($value.Length -lt 32) { return $null }
    return $value
}

function Resolve-LocalBoxGatewayToken {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$PreferRunningGateway
    )
    $tokenFile = Join-Path $Root 'launcher-gateway-token.txt'
    $stored = Get-StoredGatewayToken -Path $tokenFile
    if ($stored) { return $stored }
    if ($PreferRunningGateway) {
        $running = Get-RunningGatewayToken -Path (Join-Path $Root 'gateway.json')
        if ($running) { return (Save-LocalBoxGatewayToken -Path $tokenFile -Token $running) }
    }
    return (Save-LocalBoxGatewayToken -Path $tokenFile -Token (New-LocalBoxGatewayToken))
}

if (Test-Path -LiteralPath $hostCjs) {
    # Two independent answers to "is a box already running", and the second one
    # is the one that closes the single-instance hole: the port answers only
    # once the host is serving, while the lock answers from the moment the host
    # takes it. Either one means "do not start another".
    $existing = Get-GatewayOwner
    $lockOwner = Get-HostLockOwner -Path (Join-Path $boxRoot 'host.lock')
    if (-not $existing) { $existing = $lockOwner }
    # A token the running host already holds wins over a fresh one; otherwise a
    # second launch would leave the desktop with a credential nobody accepts.
    $gatewayToken = Resolve-LocalBoxGatewayToken -Root $boxRoot -PreferRunningGateway:([bool]$existing)
    if ($existing) {
        Write-Host "box        : already running (pid $existing)"
    } else {
        # `host.lock` used to be deleted here, on the theory that "a stale lock
        # from an unclean shutdown would make the next start fail". Measured, it
        # does not: `acquireHostLock` reads the pid in that file and already
        # reclaims it when the process is gone, when the file is unreadable and
        # when the pid is some other program entirely. Deleting it removed the
        # only evidence the lock carried, and in the window where a host has
        # taken the lock but not yet bound 8790 that evidence was the difference
        # between one host and two hosts serving the same data root.
        $boxSecretStore = Join-Path $boxRoot 'box-secrets.json'
        $boxSecrets = [ordered]@{ version = 1; secrets = [ordered]@{} }
        foreach ($name in $secrets.Keys) { $boxSecrets.secrets[$name] = $secrets[$name] }
        New-Item -ItemType Directory -Path $boxRoot -Force | Out-Null
        [System.IO.File]::WriteAllText(
            $boxSecretStore,
            ($boxSecrets | ConvertTo-Json -Depth 6),
            (New-Object System.Text.UTF8Encoding($false)))
        Protect-LocalBoxSecretFile -Path $boxSecretStore

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