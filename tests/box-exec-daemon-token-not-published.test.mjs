import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// The loopback box exec-daemon shipped `BOX_EXEC_DAEMON_AUTH_TOKEN = "local"` in
// `box-exec-daemon/server.ts` and `DEFAULT_AUTH_TOKEN = "local"` in
// `loopback-sand-box.ts`. That string was the whole credential: it is in a public
// repository, so any local process could authenticate to 127.0.0.1:1337 and run
// commands. The probe that exposed it answered 401 with no header and 404 with
// `Bearer local`, which is the signature of a *working* key. The test now proves
// the published string is rejected and that the token is unguessable.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(relative) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-box-daemon-token-"));
  const outfile = path.join(directory, `${path.basename(relative, ".ts")}.cjs`);
  await build({
    entryPoints: [path.join(repoRoot, "source", ...relative.split("/"))],
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  // CommonJS output on purpose: Connect and the protobuf runtime reach for Node
  // built-ins through `require`, which an ESM bundle cannot serve.
  return { module: createRequire(import.meta.url)(outfile), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

function probe(port, authorization) {
  return new Promise((resolve, reject) => {
    const call = request(
      { host: "127.0.0.1", port, path: "/box.v1.ControlService/Ping", method: "POST", headers: { ...(authorization === undefined ? {} : { authorization }) } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    call.on("error", reject);
    call.end();
  });
}

test("the daemon's own default token is not the published string", async (t) => {
  const { module: server, dispose } = await bundle("box-exec-daemon/server.ts");
  t.after(dispose);
  assert.notEqual(
    server.BOX_EXEC_DAEMON_AUTH_TOKEN,
    "local",
    "the daemon still falls back to the credential that is written down in a public repository",
  );
  assert.ok(
    server.BOX_EXEC_DAEMON_AUTH_TOKEN.length >= 32,
    "a short literal token is guessable by anyone who read the source, which is the whole defect",
  );
});

test("the host-side default token is not the published string", async (t) => {
  const { module: loopback, dispose } = await bundle("host/box/loopback-sand-box.ts");
  t.after(dispose);
  assert.notEqual(
    loopback.DEFAULT_AUTH_TOKEN,
    "local",
    "the client and the daemon starter still share the published string, so replacing only one side would break the daemon",
  );
  assert.ok(
    loopback.DEFAULT_AUTH_TOKEN.length >= 32,
    "the host still dials the daemon with a guessable bearer token",
  );
});

test("the daemon rejects the published string even when started with another token", async (t) => {
  const { module: server, dispose } = await bundle("box-exec-daemon/server.ts");
  t.after(dispose);
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "grok-daemon-workspace-"));
  const terminalsDirectory = mkdtempSync(path.join(os.tmpdir(), "grok-daemon-terminals-"));
  t.after(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(terminalsDirectory, { recursive: true, force: true });
  });

  const realToken = "k".repeat(43);
  const handle = await server.startBoxExecDaemon({ workspaceRoot, terminalsDirectory, authToken: realToken, port: 0 });
  t.after(() => handle.stop());

  assert.equal(
    await probe(handle.port, "Bearer local"),
    401,
    "`Bearer local` was accepted, which is the working key to command execution that the public repository published",
  );
  assert.equal(await probe(handle.port, undefined), 401, "the daemon answered an unauthenticated request");
  assert.notEqual(
    await probe(handle.port, `Bearer ${realToken}`),
    401,
    "the generated token did not authenticate, so replacing the literal would have stopped the daemon from working at all",
  );
});

test("the daemon takes its token from SAND_BOX_EXEC_DAEMON_AUTH_TOKEN, the variable the starter already exports", () => {
  const source = readFileSync(path.join(repoRoot, "source", "box-exec-daemon", "server.ts"), "utf8");
  const starter = readFileSync(path.join(repoRoot, "source", "host", "box", "exec-daemon-process.ts"), "utf8");
  assert.ok(
    /SAND_BOX_EXEC_DAEMON_AUTH_TOKEN/.test(source),
    "the daemon no longer reads the variable the starter passes, so starter and client would disagree on the token",
  );
  assert.ok(
    /SAND_BOX_EXEC_DAEMON_AUTH_TOKEN:\s*authToken/.test(starter),
    "the starter stopped handing the child its token, which would leave the host and the daemon with different credentials",
  );
});
