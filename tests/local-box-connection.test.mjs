import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// With no Cursor account the box connector could only be reached through the Cursor
// broker, and `getValidAccessToken` refused with `SandAuthSignInRequiredError`
// before a single byte left the process. That refusal reached
// `classifyGatewayFetchFailure` unmarked, so it fell through to `network` — the
// outcome the retry policy treats as a blip — and the sidebar told a signed-out
// user "Can't reach your computer" while `boundedRosterRead` spent a second attempt
// on a token it could never mint.
//
// Separately, a configured `SAND_HOST_GATEWAY_URL` selected an
// `EnvDescriptorHostConnector` that implemented `connect()` alone. The production
// binding requires `issueLocalExecDaemonCredential` to be a function while it
// builds, which threw before `createWindow()`, and `main.ts` swallowed that into
// telemetry: an external-host run produced no window and no visible error, so the
// whole `EnvDescriptorHostConnector` path had never executed.
//
// These tests execute both product modules. They prove the refusal now classifies
// as a permanent auth outcome across the real control-port boundary, that the
// roster read stops retrying it while a genuine connection refusal still retries
// once, and that the env connector answers the credential issuer the binding
// requires.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `cursor-auth.ts` and the proto/Connect transport pull CJS dependencies in, so the
 * bundle needs a `require` shim; `electron` is never entered on these paths.
 */
const BANNER = { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' };

const TOUCHED_ENV = [
  "SAND_SEND_POST_TIMEOUT_MS",
  "SAND_ROSTER_READ_TIMEOUT_MS",
  "SAND_DISABLE_SEND_ACCEPT_RETURN",
  "SAND_DISABLE_SLIM_AVATARS",
];

const savedEnv = new Map();
for (const name of TOUCHED_ENV) {
  savedEnv.set(name, process.env[name]);
  delete process.env[name];
}

/**
 * Entries carry an explicit label because `gateway-reachability.ts` exists in both
 * `shared/` and `node-agent-coordinator/gateway/`, and a basename-derived name would
 * let one bundle silently overwrite the other in the loader.
 */
async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-local-box-"));
  const names = [];
  for (const { label, path: segments } of entries) {
    names.push([label, path.join(directory, `${label}.mjs`)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...segments)],
      outfile: path.join(directory, `${label}.mjs`),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      banner: BANNER,
      logLevel: "silent",
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href + "?" + Date.now());
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  { label: "cursor-auth", path: ["electron-main", "account", "cursor-auth.ts"] },
  { label: "box-host-connector", path: ["electron-main", "box", "box-host-connector.ts"] },
  { label: "local-docker-host-connector", path: ["electron-main", "box", "local-docker-host-connector.ts"] },
  { label: "control-port-client", path: ["node-agent-coordinator", "control-port-client.ts"] },
  { label: "gateway-client", path: ["node-agent-coordinator", "gateway", "gateway-client.ts"] },
  { label: "coordinator-gateway-reachability", path: ["node-agent-coordinator", "gateway", "gateway-reachability.ts"] },
  { label: "shared-gateway-reachability", path: ["shared", "gateway-reachability.ts"] },
]);

const { SandAuthSignInRequiredError } = loaded["cursor-auth"];
const {
  BrokeredHostConnector,
  GATEWAY_URL_ENV,
  GATEWAY_TOKEN_ENV,
  SIGN_IN_REQUIRED_ACCESS_DENIED_MESSAGE,
  SIGN_IN_REQUIRED_ERROR_NAME,
  createRemoteHostConnector,
  isSignInRequiredFailure,
} = loaded["box-host-connector"];
const { createSettingsRoutedHostConnector } = loaded["local-docker-host-connector"];
const { ControlPortCallError } = loaded["control-port-client"];
const {
  CREDENTIALS_REFUSAL_CAUSE_SUMMARY,
  PERMANENT_REFUSAL_KINDS,
  SIGN_IN_REQUIRED_MESSAGE,
  CoordinatorGatewayClient,
  classifyGatewayConnectFailure,
  createCoordinatorGatewayClientTiming,
} = loaded["gateway-client"];
const { classifyGatewayFetchFailure } = loaded["coordinator-gateway-reachability"];
const { GATEWAY_ACCESS_DENIED_MESSAGE_MARKER } = loaded["shared-gateway-reachability"];

const MAIN_EXECUTION_FAILURE = "main-execution-failure";

test.after(() => {
  dispose();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/**
 * The broker client is stubbed so the only thing under test is how the connector
 * classifies the refusal the credential dependency throws. Nothing here can reach
 * the network: `ensureSandBox` rejects before any RPC.
 */
function brokerRejectingWith(failure) {
  let ensureCalls = 0;
  const connector = new BrokeredHostConnector(
    { getAccessToken: async () => { throw failure; }, getMachineId: () => "machine-under-test" },
    {
      ensureSandBox: async () => { ensureCalls += 1; throw failure; },
      recreateSandBox: async () => { throw new Error("not used"); },
      forceRecreateSandBox: async () => { throw new Error("not used"); },
    },
  );
  return { connector, ensureCalls: () => ensureCalls };
}

/**
 * Reproduces the production hop the error actually crosses: `coordinator-control-server.ts`
 * keeps only `error.message`, and `control-port-client.ts` rebuilds it as
 * `ControlPortCallError(code, message)`. The class identity is gone by then, so only
 * the message can carry the classification.
 */
function crossControlPort(error) {
  return new ControlPortCallError(MAIN_EXECUTION_FAILURE, error instanceof Error ? error.message : String(error));
}

async function captureRejection(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

test("the refusal names itself after the class account/cursor-auth.ts actually raises", () => {
  const refusal = new SandAuthSignInRequiredError();

  // A rename in cursor-auth.ts must break here rather than silently degrade the
  // connector back to the unmarked `network` classification.
  assert.equal(SIGN_IN_REQUIRED_ERROR_NAME, refusal.constructor.name, "the connector recognises a refusal class that no longer exists");
  assert.equal(SIGN_IN_REQUIRED_MESSAGE, refusal.message, "the coordinator matches a sign-in message that cursor-auth.ts no longer raises");
  assert.ok(SIGN_IN_REQUIRED_ACCESS_DENIED_MESSAGE.includes(GATEWAY_ACCESS_DENIED_MESSAGE_MARKER), "the connector's refusal message carries no marker the classifier can match");
  assert.equal(isSignInRequiredFailure(refusal), true, "the product's own sign-in refusal is not recognised by the connector");
  assert.equal(isSignInRequiredFailure(new Error("Sign in to Cursor to run Grok Bot.")), false, "a plain Error with the same text was treated as the refusal class");
  assert.equal(isSignInRequiredFailure(new Error("connect ECONNREFUSED 203.0.113.7:443")), false, "an unreachable backend was mistaken for a signed-out account");
});

test("a signed-out broker refusal reaches the coordinator as a permanent auth outcome, not a network blip", async () => {
  const { connector, ensureCalls } = brokerRejectingWith(new SandAuthSignInRequiredError());

  const failure = await captureRejection(() => connector.connect());
  assert.ok(failure !== undefined, "the broker connector reported success for a signed-out account");
  assert.equal(ensureCalls(), 1, "the broker must be asked exactly once before the refusal");
  assert.ok(
    failure.message.includes(GATEWAY_ACCESS_DENIED_MESSAGE_MARKER),
    "the refusal no longer carries the shared access-denied marker the classifier matches",
  );

  // The classifier is what the sidebar text hangs off. `network` is the lie that
  // produced "Can't reach your computer"; `access_denied` is in PERMANENT_REFUSAL_KINDS.
  const onCoordinator = crossControlPort(failure);
  const classification = classifyGatewayFetchFailure(onCoordinator);
  assert.equal(classification.outcome, "access_denied", "a signed-out user is still told the network is down");
  assert.equal(PERMANENT_REFUSAL_KINDS.has(classification.outcome), true, "the auth refusal is still treated as retryable");
});

test("the roster read reports the auth refusal and spends no second attempt on it", async () => {
  let resolveCalls = 0;
  let retries = 0;
  const reports = [];
  const client = new CoordinatorGatewayClient({
    timing: createCoordinatorGatewayClientTiming(),
    onEvent: () => {},
    onReachability: (report) => { reports.push(report); },
    onTransportRetry: () => { retries += 1; },
    // The credential dependency refuses before dispatch, so the connector never
    // got a chance to stamp the marker. The client must still classify it.
    resolveConnection: async () => {
      resolveCalls += 1;
      throw crossControlPort(new SandAuthSignInRequiredError());
    },
  });

  const failure = await captureRejection(() => client.dispatchCommand("listAgents", {}));
  assert.ok(failure !== undefined, "the roster read resolved for a signed-out account");
  assert.equal(resolveCalls, 1, "the roster read retried a refusal that a second attempt could never fix");
  assert.equal(retries, 0, "a permanent refusal was counted as a transport retry");
  assert.equal(failure.kind, "access_denied", "the refusal was still filed under a retryable network outcome");
  assert.equal(reports.at(-1).outcome, "access_denied", "the reachability report still claims a broken network");
  assert.equal(reports.at(-1).causeSummary, CREDENTIALS_REFUSAL_CAUSE_SUMMARY, "the report does not name the missing credentials as the cause");
});

test("a genuine connection refusal still retries once and still reads as a transport failure", async () => {
  let resolveCalls = 0;
  let retries = 0;
  const client = new CoordinatorGatewayClient({
    timing: createCoordinatorGatewayClientTiming(),
    onEvent: () => {},
    onTransportRetry: () => { retries += 1; },
    resolveConnection: async () => {
      resolveCalls += 1;
      throw crossControlPort(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1340"), { code: "ECONNREFUSED" }));
    },
  });

  const failure = await captureRejection(() => client.dispatchCommand("listAgents", {}));
  assert.ok(failure !== undefined, "the roster read resolved against a refused connection");
  // The control port keeps only the message, so the errno is gone and the outcome
  // stays the generic transport one. That is pre-existing and correct enough: what
  // matters is that it is not promoted to a permanent auth refusal.
  assert.equal(PERMANENT_REFUSAL_KINDS.has(failure.kind), false, "a refused connection was promoted to a permanent auth refusal");
  assert.equal(failure.kind, "network", "a refused connection is no longer reported as a transport failure");
  assert.equal(resolveCalls, 2, "a genuine transport failure lost its bounded retry");
  assert.equal(retries, 1, "a genuine transport failure was not counted as a retry");
});

test("only a credential refusal is promoted, and only when no permanent outcome was reached first", () => {
  // Where the errno does survive, the classifier must still map it to `refused`.
  assert.equal(
    classifyGatewayFetchFailure(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1340"), { code: "ECONNREFUSED" })).outcome,
    "refused",
    "a refused connection with a surviving errno is no longer classified as refused",
  );
  // The credentials check must not reach past an outcome that is already permanent.
  assert.equal(
    classifyGatewayFetchFailure(new Error("already permanent")).outcome,
    "network",
    "an unrelated failure was promoted to a permanent refusal",
  );
  assert.equal(
    classifyGatewayConnectFailure(new Error(`wrapped: ${new SandAuthSignInRequiredError().message}`)).outcome,
    "access_denied",
    "a sign-in refusal buried under a cause chain was classified as something retryable",
  );
  assert.equal(
    classifyGatewayConnectFailure(new Error(`wrapped: ${new SandAuthSignInRequiredError().message}`)).causeSummary,
    CREDENTIALS_REFUSAL_CAUSE_SUMMARY,
    "the promoted refusal does not name the missing credentials as the cause",
  );
});

test("a configured gateway URL wins over the broker and is reached without asking for a credential", async () => {
  let credentialRequests = 0;
  const env = {
    [GATEWAY_URL_ENV]: "http://127.0.0.1:1340",
    [GATEWAY_TOKEN_ENV]: "external-host-token",
  };
  const connector = createRemoteHostConnector({
    getAccessToken: async () => { credentialRequests += 1; throw new SandAuthSignInRequiredError(); },
    getMachineId: () => "machine-under-test",
  }, env);

  const connection = await connector.connect();
  assert.equal(connection.baseUrl, "http://127.0.0.1:1340", "the external host was not preferred over the Cursor broker");
  assert.equal(connection.token, "external-host-token", "the external host token was not carried into the connection");
  assert.equal(credentialRequests, 0, "the external host path still demanded a Cursor credential");
});

test("the env connector answers the credential issuer the production binding requires to exist", async () => {
  const env = { [GATEWAY_URL_ENV]: "http://127.0.0.1:1340", [GATEWAY_TOKEN_ENV]: "external-host-token" };
  const connector = createRemoteHostConnector({ getAccessToken: async () => { throw new Error("not used"); }, getMachineId: () => "machine" }, env);

  // `adapters/coordinator-gateway.ts` calls `requireFunction` on exactly these two.
  // A missing method there threw during wiring, before `createWindow()`.
  assert.equal(typeof connector.connect, "function", "the settings-routed connector has no connect() for the binding to require");
  assert.equal(typeof connector.issueLocalExecDaemonCredential, "function", "the binding still throws because the local-exec credential issuer is absent");
  assert.equal(await connector.issueLocalExecDaemonCredential(), undefined, "an external host claimed to mint a local-exec credential it cannot mint");
  assert.equal(typeof connector.issueInferenceCredential, "function", "the local-Docker path loses its inference-credential probe");

  // The same two members must survive the settings router that wraps this connector.
  const routed = createSettingsRoutedHostConnector(connector, {
    settingsPath: path.join(repoRoot, "settings-under-test.json"),
    getBoxRuntime: () => "remote",
  });
  assert.equal(typeof routed.issueLocalExecDaemonCredential, "function", "the settings router dropped the issuer the binding requires");
  assert.equal(await routed.issueLocalExecDaemonCredential(), undefined, "the routed connector invented a local-exec credential");
  const routedConnection = await routed.connect();
  assert.equal(routedConnection.baseUrl, "http://127.0.0.1:1340", "the settings router sent a signed-out user back to the Cursor broker");
});

test("a broker client that is merely offline is still a transport failure", async () => {
  const offline = Object.assign(new Error("connect ECONNREFUSED 203.0.113.7:443"), { code: "ECONNREFUSED" });
  const failure = await captureRejection(() => brokerRejectingWith(offline).connector.connect());

  assert.ok(failure !== undefined, "the broker connector reported success against a refused backend");
  assert.ok(!failure.message.includes(GATEWAY_ACCESS_DENIED_MESSAGE_MARKER), "an unreachable backend was dressed up as an auth refusal");
  assert.equal(PERMANENT_REFUSAL_KINDS.has(classifyGatewayFetchFailure(crossControlPort(failure)).outcome), false, "an unreachable backend was promoted to a permanent auth refusal");
  assert.equal(classifyGatewayFetchFailure(crossControlPort(failure)).outcome, "network", "an unreachable backend stopped reading as a transport failure");
});