import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as acorn from "acorn";
import { build, transform } from "esbuild";

/**
 * `SAND_GATEWAY_COMMANDS.getTranscript` used to read `(api) => api.getTranscript()`. It was the
 * only entry in the 122-command table that never declared a `body` parameter, so
 * `routeCommand` handed it the parsed request and the handler discarded it before the API was
 * called. `host-gateway-api.ts` reads `args?.agentId ?? args?.id`, saw `undefined`, and answered
 * for the active session instead. Three different agent ids then produced three byte-identical
 * transcripts: the response looked like a successful answer about the requested agent while
 * describing a different conversation entirely, which is why it survived review.
 *
 * A dropped argument is worse than a missing one, so this file checks every command rather than
 * the one that was reported. The set of commands that *must* receive an argument is derived from
 * the API implementation with an AST walk, never hand-written: a hand-written list goes stale the
 * moment a command is added and then the guard silently stops guarding.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-gateway-args-"));
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.mjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([["host", "gateway-protocol.ts"]]);
const { SAND_GATEWAY_COMMANDS, SAND_GATEWAY_SLIM_COMMANDS } = loaded["gateway-protocol.mjs"];
test.after(() => dispose());

/**
 * Reads `createHostGatewayApi`'s returned object out of the API source and reports, per method,
 * which parameters it names. A method that names no parameter cannot read an argument, so its
 * command does not need a body; everything else does.
 */
async function apiMethodParameters() {
  const file = path.join(repoRoot, "source", "host", "host-gateway-api.ts");
  // The file is TypeScript, so it is stripped before it is parsed; every slice below is taken
  // from the same stripped text, which keeps the offsets and the source in step.
  const source = (
    await transform(readFileSync(file, "utf8"), { loader: "ts", format: "esm" })
  ).code;
  const tree = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  });

  // `listRoutedMcpTools` and `executeRoutedMcpTool` are shorthand properties pointing at local
  // const arrows, so those arrows are indexed separately before the properties are read.
  const locals = new Map();
  (function scanLocals(node) {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) return void node.forEach(scanLocals);
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "ArrowFunctionExpression"
    )
      locals.set(node.id.name, node.init);
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      scanLocals(node[key]);
    }
  })(tree);

  const names = (param) =>
    param.type === "Identifier"
      ? [param.name]
      : (param.properties ?? [])
          .filter((p) => p.type === "Property" || p.type === "AssignmentPattern")
          .map((p) => (p.type === "AssignmentPattern" ? p.left : p.value).name)
          .filter(Boolean);

  const methods = new Map();
  (function scan(node) {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) return void node.forEach(scan);
    if (node.type === "Property" && node.key?.type === "Identifier") {
      const fn =
        node.value.type === "ArrowFunctionExpression"
          ? node.value
          : node.value.type === "Identifier"
            ? locals.get(node.value.name)
            : null;
      if (fn != null) {
        const declared = fn.params.flatMap(names);
        // A parameter only counts as read when its name appears in the function body.
        const body = source.slice(fn.body.start, fn.body.end);
        const read = declared.filter((n) =>
          new RegExp(`\\b${n.replace(/[$]/g, "\\$")}\\b`).test(body)
        );
        methods.set(node.key.name, { declared, read });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      scan(node[key]);
    }
  })(tree);
  return methods;
}

const API_METHODS = await apiMethodParameters();
const NEEDS_ARGUMENT = new Set(
  [...API_METHODS].filter(([, m]) => m.read.length > 0).map(([name]) => name)
);

/** Records what each gateway command hands to the API, and mirrors the real fallback to the
 * active session that made the defect invisible. */
function createRecordingApi() {
  const calls = [];
  const api = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== "string") return undefined;
        return (args) => {
          calls.push({ name, args });
          const id = args?.agentId ?? args?.id;
          // The `agent` field keeps the slim table's `stripCreateAgentResult` satisfied; without
          // it the slim wrappers would throw on a stub that never shaped a create result.
          return {
            answeredFor: typeof id === "string" && id.length > 0 ? id : "ACTIVE-SESSION",
            agent: { id, avatarDataUrl: null },
          };
        };
      },
    }
  );
  return { api, calls };
}

async function invoke(table, command, body) {
  const { api, calls } = createRecordingApi();
  await table[command](api, JSON.stringify(body));
  return calls;
}

const PROBE_BODY = {
  id: "agent-under-test",
  agentId: "agent-under-test",
  rootId: "root-under-test",
  query: "probe",
  prompt: "probe",
  spec: { name: "probe" },
  platform: "probe",
};

test("the sweep inspected the whole command table and found commands that need an argument", () => {
  // A guard that matches nothing is a guard that proves nothing.
  assert.ok(
    Object.keys(SAND_GATEWAY_COMMANDS).length >= 100,
    `the table was expected to carry the whole shipped surface, found ${Object.keys(SAND_GATEWAY_COMMANDS).length} commands`
  );
  assert.ok(
    NEEDS_ARGUMENT.size >= 50,
    `the AST walk was expected to find the argument-taking commands, found ${NEEDS_ARGUMENT.size}`
  );
  assert.ok(NEEDS_ARGUMENT.has("getTranscript"), "getTranscript reads its argument, so the walk must see it");
  assert.equal(
    [...API_METHODS].every(([name]) => Object.hasOwn(SAND_GATEWAY_COMMANDS, name)),
    true,
    "every API method must be reachable as a gateway command"
  );
});

test("every command that needs an argument receives the request body", async () => {
  const dropped = [];
  for (const command of NEEDS_ARGUMENT) {
    assert.ok(
      Object.hasOwn(SAND_GATEWAY_COMMANDS, command),
      `${command} reads an argument but no gateway command can reach it`
    );
    const calls = await invoke(SAND_GATEWAY_COMMANDS, command, PROBE_BODY);
    assert.equal(calls.length, 1, `${command} must call the API exactly once`);
    assert.equal(calls[0].name, command, `${command} must call its own API method`);
    assert.equal(
      calls[0].args?.id,
      PROBE_BODY.id,
      `${command} dropped the request body: the API received ${JSON.stringify(calls[0].args)}`
    );
    if (calls[0].args?.id !== PROBE_BODY.id) dropped.push(command);
  }
  assert.deepEqual(dropped, [], `these commands answer about something other than what was asked: ${dropped.join(", ")}`);
});

test("every command that needs an argument also receives it on the slim-avatar transport", async () => {
  // The dispatcher picks the slim table from a request header, so a fix that only lands in the
  // base table would still drop the argument for every client that asks for slim avatars.
  const dropped = [];
  for (const command of NEEDS_ARGUMENT) {
    const calls = await invoke(SAND_GATEWAY_SLIM_COMMANDS, command, PROBE_BODY);
    if (calls.at(-1)?.args?.id !== PROBE_BODY.id) dropped.push(command);
  }
  assert.deepEqual(dropped, [], `the slim command table drops the body for: ${dropped.join(", ")}`);
});

test("a command that declares no body parameter is allowed only when its API reads no argument", () => {
  const offenders = [];
  for (const command of Object.keys(SAND_GATEWAY_COMMANDS)) {
    const declared = SAND_GATEWAY_COMMANDS[command].length;
    if (declared >= 2) continue;
    if (NEEDS_ARGUMENT.has(command)) offenders.push(command);
  }
  assert.deepEqual(
    offenders,
    [],
    `these commands accept no body while their API reads one, so they answer about the wrong thing: ${offenders.join(", ")}`
  );
});

test("getTranscript tells three different agents apart instead of answering about the active one", async () => {
  const ids = ["agent-alpha", "agent-bravo", "agent-charlie"];
  const answered = [];
  for (const id of ids) {
    const calls = await invoke(SAND_GATEWAY_COMMANDS, "getTranscript", { id });
    answered.push(calls[0].args && `${calls[0].args.id}`);
  }

  // Before the fix every one of these was "undefined": the API received no argument at all and
  // fell through to the active session, which is what made three probes byte-identical.
  assert.deepEqual(
    answered,
    ids,
    "getTranscript did not carry the requested agent id to the API, so the API answered for the active session instead"
  );
  assert.equal(
    new Set(answered).size,
    ids.length,
    "three different agent ids collapsed into one answer, which is the byte-identical-transcript defect"
  );
});

test("getTranscript accepts the agentId spelling as well as id", async () => {
  const calls = await invoke(SAND_GATEWAY_COMMANDS, "getTranscript", { agentId: "spelled-agent-id" });
  assert.equal(
    calls[0].args?.agentId,
    "spelled-agent-id",
    "the body reached the API but the field the API reads was not present"
  );
});

test("an empty request body becomes an empty object rather than a parse failure", async () => {
  const { api, calls } = createRecordingApi();
  await SAND_GATEWAY_COMMANDS.getAgentTranscript(api, "");
  assert.deepEqual(
    calls[0].args,
    {},
    "a request with no body must reach the API as an empty object so the API can decide what to do"
  );
});