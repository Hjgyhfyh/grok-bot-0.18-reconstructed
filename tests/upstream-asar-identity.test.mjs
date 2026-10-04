import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// `scripts/lib/config.mjs` used to compute the pinned upstream ASAR identity
// inline while the module loaded, from `process.platform`. One host therefore
// could never observe both halves of the split: hardcoding the macOS hash on
// every platform produced an identical module on this machine, so the macOS
// versus Windows decision was invisible to the whole suite.
//
// The two constants below are literals, so they are safe to read directly. Every
// assertion about the SELECTION runs in a child process with a controlled
// environment, because the selection is evaluated while the module loads.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configUrl = pathToFileURL(path.join(repoRoot, "scripts", "lib", "config.mjs")).href;
const { macosUpstreamAsarSha256, windowsUpstreamAsarSha256 } = await import(configUrl);

const OVERRIDE = "f".repeat(64);

const PROBE = `
  const module = await import(${JSON.stringify(configUrl)});
  console.log(JSON.stringify({
    win32: module.selectUpstreamAsarSha256("win32"),
    darwin: module.selectUpstreamAsarSha256("darwin"),
    linux: module.selectUpstreamAsarSha256("linux"),
    defaulted: module.selectUpstreamAsarSha256(),
    current: module.upstreamAsarSha256,
  }));
`;

function probe(env) {
  const clean = { ...process.env };
  delete clean.GROK_BOT_UPSTREAM_ASAR_SHA256;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", PROBE], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...clean, ...env },
  });
  return JSON.parse(output);
}

test("the pinned upstream ASAR identities are distinct per platform", () => {
  assert.match(macosUpstreamAsarSha256, /^[0-9a-f]{64}$/);
  assert.match(windowsUpstreamAsarSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(
    macosUpstreamAsarSha256,
    windowsUpstreamAsarSha256,
    "pinning one platform's hash as both constants would make the platform split a lie",
  );
});

test("selectUpstreamAsarSha256 answers for both platforms regardless of the host", () => {
  const plain = probe({});
  assert.equal(
    plain.win32,
    windowsUpstreamAsarSha256,
    "a Windows host must verify the Windows 0.18.0 app.asar",
  );
  assert.equal(
    plain.darwin,
    macosUpstreamAsarSha256,
    "a macOS host must verify the macOS 0.18.0 app.asar",
  );
  assert.notEqual(
    plain.win32,
    plain.darwin,
    "the platform choice must be observable from a single host",
  );
  assert.equal(
    plain.defaulted,
    process.platform === "win32" ? windowsUpstreamAsarSha256 : macosUpstreamAsarSha256,
    "the default platform argument must resolve to this host",
  );
  assert.equal(
    plain.linux,
    macosUpstreamAsarSha256,
    "only win32 selects the Windows artifact; every other host builds the macOS runtime",
  );
});

test("the module-level pin matches this host's platform selection", () => {
  const plain = probe({});
  assert.equal(plain.current, plain.defaulted);
});

test("GROK_BOT_UPSTREAM_ASAR_SHA256 still overrides both platform pins", () => {
  const overridden = probe({ GROK_BOT_UPSTREAM_ASAR_SHA256: OVERRIDE });
  assert.equal(overridden.win32, OVERRIDE);
  assert.equal(overridden.darwin, OVERRIDE);
  assert.equal(overridden.defaulted, OVERRIDE);
  assert.equal(overridden.current, OVERRIDE);
});

test("a blank override is ignored rather than pinning an empty identity", () => {
  const blank = probe({ GROK_BOT_UPSTREAM_ASAR_SHA256: "   " });
  assert.equal(blank.win32, windowsUpstreamAsarSha256);
  assert.equal(blank.darwin, macosUpstreamAsarSha256);
  assert.match(blank.current, /^[0-9a-f]{64}$/);
});
