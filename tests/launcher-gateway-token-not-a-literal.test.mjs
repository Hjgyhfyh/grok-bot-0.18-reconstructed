import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// `scripts/start-grokbot.ps1` pinned the loopback gateway bearer token to the
// literal `grok-local-box-token-abc123`, and the host then copied that literal
// into `%LOCALAPPDATA%\GrokBotLocalBox\gateway.json`. A live probe with that
// string reached `setBoxSecrets`, `deleteAgents`, `setHostSettings` and
// `sendPrompt` — every one answered 200 and ran the method. Because the literal
// is in a public repository, it was not a secret at all: any local process owned
// the host. The test now proves the launcher mints an unguessable token, keeps
// it across restarts, adopts the token of an already-running box, and says in
// its own header that `box-secrets.json` holds plaintext.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = path.join(repoRoot, "scripts", "start-grokbot.ps1");
const launcherSource = readFileSync(launcherPath, "utf8");

const HARNESS = `
param([string]$ScriptPath, [string]$Root, [switch]$PreferRunningGateway)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { [pscustomobject]@{ ok = $false; parseErrors = @($errors | ForEach-Object { $_.Message }) } | ConvertTo-Json -Compress; exit 0 }
$wanted = @('New-LocalBoxGatewayToken','Get-StoredGatewayToken','Get-RunningGatewayToken','Save-LocalBoxGatewayToken','Protect-LocalBoxSecretFile','Resolve-LocalBoxGatewayToken')
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($wanted -contains $fn.Name) { Invoke-Expression $fn.Extent.Text }
}
$missing = @($wanted | Where-Object { -not (Get-Command -Name $_ -ErrorAction SilentlyContinue) })
if ($missing.Count -gt 0) { [pscustomobject]@{ ok = $false; missing = $missing } | ConvertTo-Json -Compress; exit 0 }
$first = Resolve-LocalBoxGatewayToken -Root $Root -PreferRunningGateway:$PreferRunningGateway
$second = Resolve-LocalBoxGatewayToken -Root $Root -PreferRunningGateway:$PreferRunningGateway
$tokenFile = Join-Path $Root 'launcher-gateway-token.txt'
[pscustomobject]@{
    ok = $true
    first = $first
    second = $second
    tokenFileExists = (Test-Path -LiteralPath $tokenFile)
    stored = Get-StoredGatewayToken -Path $tokenFile
    fresh = (New-LocalBoxGatewayToken)
    freshAgain = (New-LocalBoxGatewayToken)
} | ConvertTo-Json -Compress
`;

function runLauncher(root, { preferRunningGateway = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-launcher-harness-"));
  const harness = path.join(directory, "harness.ps1");
  writeFileSync(harness, HARNESS, "utf8");
  try {
    const stdout = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness, "-ScriptPath", launcherPath, "-Root", root, ...(preferRunningGateway ? ["-PreferRunningGateway"] : [])],
      { encoding: "utf8", windowsHide: true },
    );
    return JSON.parse(stdout.trim());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function freshRoot(label) {
  const root = mkdtempSync(path.join(os.tmpdir(), `grok-launcher-${label}-`));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

test("the launcher mints an unguessable token and keeps it for the next start", () => {
  const result = runLauncher(freshRoot("fresh"));
  assert.deepEqual(result.missing, undefined, "the launcher grew no token functions, so the literal is still the only source of the credential");
  assert.equal(result.ok, true, `the launcher token functions did not run: ${JSON.stringify(result)}`);
  assert.ok(BASE64URL_32_BYTES.test(result.first), `the generated token is not 32 random bytes in base64url: ${String(result.first).slice(0, 8)}...`);
  assert.notEqual(result.first, "grok-local-box-token-abc123", "the launcher still hands out the published token");
  assert.equal(result.second, result.first, "a second launch minted a different token, so the running box and the desktop would not agree");
  assert.equal(result.stored, result.first, "the token was not persisted, so the next start could not authenticate");
  assert.equal(result.tokenFileExists, true, "no token file was written, so the next start would mint a second credential");
});

test("two launches on different machines state produce different tokens", () => {
  const first = runLauncher(freshRoot("machine-a"));
  const second = runLauncher(freshRoot("machine-b"));
  assert.notEqual(first.first, second.first, "a fixed token is a published token, which is the defect this closes");
  assert.notEqual(first.fresh, first.freshAgain, "the generator returned a constant, so every box would share one key");
});

test("an existing token file is adopted instead of replaced", () => {
  const root = freshRoot("existing");
  const planted = "z".repeat(43);
  writeFileSync(path.join(root, "launcher-gateway-token.txt"), `${planted}\n`, "utf8");
  const result = runLauncher(root);
  assert.equal(result.first, planted, "the launcher overwrote a stored token, so an already-configured desktop would lose access");
  assert.equal(result.second, planted, "the stored token was not stable across calls, so a restart would break the box");
});

test("an already-running box keeps the token it published", () => {
  const root = freshRoot("running");
  const runningToken = "q".repeat(43);
  writeFileSync(
    path.join(root, "gateway.json"),
    JSON.stringify({ port: 8790, pid: 15004, startedAt: 1, scheme: "http", host: "127.0.0.1", token: runningToken }),
    "utf8",
  );
  const result = runLauncher(root, { preferRunningGateway: true });
  assert.equal(result.first, runningToken, "the launcher minted a fresh token while the running host kept the old one, so the desktop would get 401 on every command");
});

test("the published literal is gone from the launcher", () => {
  assert.equal(
    /grok-local-box-token-abc123/.test(launcherSource),
    false,
    "the gateway bearer token is still a literal in a public repository, so every local process owns the host",
  );
  assert.ok(
    /SAND_HOST_GATEWAY_TOKEN\s*=\s*\$gatewayToken/.test(launcherSource),
    "the desktop no longer receives the same token the host was started with",
  );
  assert.ok(
    /SAND_GATEWAY_TOKEN\s*=\s*\$gatewayToken/.test(launcherSource),
    "the host is no longer started with the token the desktop will use",
  );
});

test("the launcher header no longer claims the credentials are never written in plaintext", () => {
  const header = launcherSource.split("\n").slice(0, 14).join("\n");
  assert.equal(
    /never written in plaintext/i.test(header),
    false,
    "the header still promises plaintext is never written while lines 104-111 decrypt DPAPI straight into box-secrets.json",
  );
  assert.ok(
    /box-secrets\.json/.test(header),
    "the header does not name the file that does hold the credentials in plaintext, so a reader cannot see the exposure",
  );
});
