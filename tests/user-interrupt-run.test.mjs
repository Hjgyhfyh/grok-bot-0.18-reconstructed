import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// There was no way to stop a running agent at any moment.
//
// The abort machinery was all present and all internal. `SandAgentRunner.interruptAll`
// aborts the active run's `AbortController` and then walks `subagents.sessions`, and
// everything a turn owns hangs off that one signal: the model stream reads
// `context.signal` (`chat-inference-proto/client.ts:193`), a waiting local-tool
// permission ask settles on it (`local-tool-permission-controller.ts:134`), and a
// running shell hands it to `createShellProcessGuard`, which walks the process tree
// with `taskkill /T` before releasing the direct kill (`process-tree.ts:213`).
// Four internal callers could reach it — the run-queue watchdog, agent deletion, a
// superseding user message, and a parent agent steering a subagent — and nothing a
// person can press could. `SAND_GATEWAY_COMMANDS` had no stop entry, so the live box
// answered `404 unknown gateway method` for every plausible name, and `dispose()`
// dropped the runners after cancelling only the shell *rewatch poller*, which left a
// live shell and its children behind on shutdown.
//
// The tests below fail against the state before this change (no command in the table,
// no method on the registry, no interrupt on shutdown) and against the three
// plausible wrong fixes: a stop that aborts only the parent turn and leaves
// subagents running, a stop that reports success for an agent that never ran, and a
// guard that kills the shell without walking the tree.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-stop-"));
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
  for (const [name, file] of names) loaded[name] = await import(`${pathToFileURL(file).href}?${Date.now()}`);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "gateway-protocol.ts"],
  ["host", "extensions", "transcript", "runner-registry.ts"],
  ["host", "extensions", "local-tool-permission", "local-tool-permission-controller.ts"],
  ["shared", "rpc", "coordinator.ts"],
]);

const { SAND_GATEWAY_COMMANDS, SAND_GATEWAY_SLIM_COMMANDS } = loaded["gateway-protocol.mjs"];
const { RunnerRegistry } = loaded["runner-registry.mjs"];
const { SandLocalToolPermissionController, SAND_LOCAL_TOOLS_ASK_CANCELLED_MESSAGE } =
  loaded["local-tool-permission-controller.mjs"];
const { COORDINATOR_METHOD_TABLE, isCoordinatorMethod } = loaded["coordinator.mjs"];

test.after(() => dispose());

const AGENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

// ---------------------------------------------------------------------------
// 1. The stop is reachable. A missing table entry is silent — `routeCommand`
//    answers 404 and nothing throws — so this has to be asserted, not assumed.
// ---------------------------------------------------------------------------

test("the gateway serves a stop command, and it forwards the agent id and the reason", () => {
  assert.equal(
    typeof SAND_GATEWAY_COMMANDS.interruptAgentRun,
    "function",
    "there is no stop on the loopback gateway, so the user's only way to end a turn does not exist",
  );

  const calls = [];
  const api = { interruptAgentRun: (...args) => { calls.push(args); return { interrupted: true, hadRunningSubagents: false }; } };
  const result = SAND_GATEWAY_COMMANDS.interruptAgentRun(api, JSON.stringify({ id: AGENT, reason: "the user pressed stop" }));

  assert.equal(result.interrupted, true, "the command table swallowed the answer, so the renderer cannot learn whether anything was stopped");
  assert.deepEqual(
    calls,
    [[{ id: AGENT, reason: "the user pressed stop" }]],
    "the handler discarded the agent id, so the stop would land on whichever agent happened to be active",
  );

  // The slim-avatar transport is a second table the renderer may be served by, and
  // a command present in only one of them is reachable only sometimes.
  assert.equal(
    typeof SAND_GATEWAY_SLIM_COMMANDS.interruptAgentRun,
    "function",
    "the stop is served on the full table and refused on the slim one, so whether the user can stop depends on a transport header",
  );
});

test("the renderer's coordinator serves the stop instead of refusing it by name", () => {
  // `isCoordinatorMethod` is a pure table lookup and `createGatewayRequestDispatch`
  // refuses anything it does not name, before a request is made at all. So an
  // absent entry here means the renderer's roster can never reach the host's stop,
  // whatever the gateway answers.
  assert.equal(
    isCoordinatorMethod("interruptAgentRun"),
    true,
    "the renderer is refused with 'no coordinator method named interruptAgentRun', so a stop button on it could never work",
  );
  assert.deepEqual(
    COORDINATOR_METHOD_TABLE.interruptAgentRun,
    { args: "object", reply: "record" },
    "the coordinator no longer describes what the stop takes or answers, so the renderer's client has nothing to build a call from",
  );
});

// ---------------------------------------------------------------------------
// 2. The stop reaches the turn and the subagents.
// ---------------------------------------------------------------------------

/**
 * A stand-in for `SandAgentRunner` with the one property that matters here:
 * `interruptAll` answers whether an ACTIVE RUN took the abort, which is what the
 * real `interrupt` inside it returns. A fake that always answered `true` would
 * make "the stop reports what it did" pass for the wrong reason.
 */
function fakeRunner({ running = true, subagents = [] } = {}) {
  const interrupts = [];
  let alive = running;
  return {
    interrupts,
    hasRunningSubagents: () => alive && subagents.length > 0,
    interruptAll(reason) {
      interrupts.push(reason);
      const hadActiveRun = alive;
      alive = false;
      return hadActiveRun;
    },
  };
}

function registryWith(runners = {}, groupRunners = {}) {
  const registry = new RunnerRegistry({});
  for (const [id, runner] of Object.entries(runners)) registry.runners.set(id, runner);
  for (const [id, runner] of Object.entries(groupRunners)) registry.activeGroupMemberRunners.set(id, runner);
  return registry;
}

test("the stop interrupts the running turn of the agent that was named", () => {
  const runner = fakeRunner();
  const registry = registryWith({ [AGENT]: runner });

  const result = registry.interruptUserRun(AGENT, "the user pressed stop");

  assert.equal(result.interrupted, true, "the stop reported that nothing was running while a turn was in flight");
  assert.deepEqual(
    runner.interrupts,
    ["the user pressed stop"],
    "the agent's runner was never asked to stop, so the model stream kept going",
  );
});

test("the stop reaches the subagents the turn dispatched, not only the turn itself", () => {
  // `SandAgentRunner.interruptAll` is the primitive, and it does two things: it
  // aborts the active run and it walks `subagents.sessions`. A stop that called the
  // other method on the runner — `interrupt` — would stop the parent turn and leave
  // every child running, which is the failure that makes a stop look like it worked.
  const subagentSessions = new Map([
    ["child-a", { interrupt: (reason) => { interruptedChildren.push(["child-a", reason]); } }],
    ["child-b", { interrupt: (reason) => { interruptedChildren.push(["child-b", reason]); } }],
  ]);
  const interruptedChildren = [];

  const runner = {
    interrupts: [],
    hasRunningSubagents: () => true,
    // The shape of `SandAgentRunner.interruptAll` as it is written:
    // `interrupt` for the run, then every subagent session.
    interruptAll(reason) {
      this.interrupts.push(reason);
      for (const session of subagentSessions.values()) session.interrupt(reason);
      return true;
    },
  };
  const registry = registryWith({ [AGENT]: runner });

  const result = registry.interruptUserRun(AGENT, "stop everything");

  assert.equal(result.hadRunningSubagents, true, "the stop reported no subagents were running while two were");
  assert.deepEqual(
    interruptedChildren,
    [["child-a", "stop everything"], ["child-b", "stop everything"]],
    "the children were never interrupted, so the parent stopped and the work it started kept running",
  );
});

test("the stop reports what it did rather than claiming an agent that never ran was stopped", () => {
  const registry = registryWith({ [AGENT]: fakeRunner({ running: false, subagents: [] }) });
  const result = registry.interruptUserRun(AGENT, "stop");

  assert.equal(result.interrupted, false, "an idle agent was reported as interrupted, so a caller cannot tell a no-op from a real stop");
  assert.equal(result.hadRunningSubagents, false, "an agent with no subagents was reported as having had running subagents");
});

test("asking to stop an agent that has no runner creates nothing and lies about nothing", () => {
  let created = 0;
  const registry = registryWith();
  registry.getRunner = () => { created += 1; return fakeRunner(); };

  const result = registry.interruptUserRun(AGENT, "stop");

  assert.equal(created, 0, "asking whether an agent was busy brought a runner into existence as a side effect");
  assert.deepEqual(
    result,
    { interrupted: false, hadRunningSubagents: false },
    "stopping an agent that never ran was reported as anything other than a no-op",
  );
});

test("the stop reaches a group room member's turn as well as a direct chat's", () => {
  const direct = fakeRunner();
  const group = fakeRunner();
  const registry = registryWith({ [AGENT]: direct }, { [AGENT]: group });

  registry.interruptUserRun(AGENT, "stop");

  assert.deepEqual(direct.interrupts, ["stop"], "the direct-chat runner was left running");
  assert.deepEqual(group.interrupts, ["stop"], "a group room member keeps running after the user pressed stop, and the room is exactly where it is visible");
});

// ---------------------------------------------------------------------------
// 3. The permission ask. This is the sub-case the abort alone does not cover:
//    the question the user is looking at blocks the tool call until somebody
//    answers, and "nobody" meant ten minutes.
// ---------------------------------------------------------------------------

function permissionController() {
  let permission = "ask";
  return new SandLocalToolPermissionController({
    getPermission: () => permission,
    setPermission: (next) => { permission = next; },
    canAsk: () => true,
    hasLiveComputer: () => true,
  });
}

test("stopping a turn that is blocked on a permission question releases the tool call", async () => {
  const controller = permissionController();
  const scope = { agentId: AGENT, toolCallId: "call-1" };
  const turn = new AbortController();

  const asked = controller.authorize(scope, {
    action: "run-command",
    target: "del C:\\everything",
    signal: turn.signal,
  });

  // The ask is open and the tool call is blocked on it. This is the state a user
  // stares at with no way out.
  assert.ok(
    controller.getPendingRequestForAgent(AGENT),
    "the question was never asked, so there is nothing here to release",
  );

  turn.abort({ intentional: true, reason: "the user pressed stop" });

  const decision = await asked;
  assert.equal(decision.allowed, false, "an aborted turn was told the action was approved, so the command runs after the user stopped it");
  assert.equal(
    decision.reason,
    SAND_LOCAL_TOOLS_ASK_CANCELLED_MESSAGE,
    "the agent was told the user declined instead of that they were never asked, and will refuse this command forever",
  );
  assert.equal(
    controller.getPendingRequestForAgent(AGENT),
    undefined,
    "the ask stayed pending after the turn was aborted, so a later answer settles a question nobody is waiting for",
  );
});

test("a question the user did stop is not remembered as a refusal the user gave", async () => {
  // `isUserRefusal` deliberately excludes an expired or cancelled ask, because a
  // remembered refusal outranks the `always` setting. If a cancellation were
  // remembered, the first ask a user stopped would answer every later request for
  // the same command with "you already refused this" and nothing could lift it.
  const controller = permissionController();
  const turn = new AbortController();
  const asked = controller.authorize(
    { agentId: AGENT, toolCallId: "call-1" },
    { action: "run-command", target: "del C:\\everything", signal: turn.signal },
  );
  turn.abort();
  await asked;

  const later = controller.authorize(
    { agentId: AGENT, toolCallId: "call-2" },
    { action: "run-command", target: "del C:\\everything" },
  );
  try {
    assert.notEqual(
      later.reason,
      "The user was already asked about this exact action on their computer and did not approve it, so it will not run and will not be asked again for this task — a later permission change does not authorize it. Do not retry it. If it still needs to happen, say so in chat and let the user ask for it, and use your own computer in the meantime (Shell, Read, AwaitShell).",
      "a cancellation was remembered as the user's own refusal, so stopping the agent permanently bans the command",
    );
  } finally {
    // An open ask holds a referenced timer for its whole ten-minute TTL by design
    // (see the `delay` comment in the controller), so a test that walks away from
    // one keeps the process alive long after the assertion is done.
    controller.beginTurn(AGENT);
  }
});

// ---------------------------------------------------------------------------
// 4. Shutdown. A stop nobody named must not leak a process tree either.
// ---------------------------------------------------------------------------

test("shutdown interrupts the runners instead of only cancelling the rewatch poller", async () => {
  const managerSource = readFileSync(
    path.join(repoRoot, "source", "host", "extensions", "transcript", "transcript-manager.ts"),
    "utf8",
  );
  const dispose = managerSource.slice(managerSource.indexOf("this.unwatchActiveSession()"));
  assert.ok(dispose.length > 0, "the dispose block could not be located, so this guard is not looking at the code it claims to");

  const clearRunners = dispose.indexOf("this.runnerRegistry.runners.clear()");
  const clearGroup = dispose.indexOf("this.runnerRegistry.activeGroupMemberRunners.clear()");
  assert.ok(clearRunners > 0 && clearGroup > clearRunners, "dispose no longer clears the runner maps in that order, so this guard is reading a shape that changed");

  // Each region is counted in its OWN span. An earlier version sliced "everything
  // before the group clear", which also contains the direct-runner interrupt — so
  // deleting the group interrupt entirely still passed, because the guard had found
  // a different `interruptAll` and called that a proof. A static guard that finds
  // the wrong occurrence is worse than none.
  const directRegion = dispose.slice(0, clearRunners);
  const groupRegion = dispose.slice(clearRunners, clearGroup);
  const interruptsBeforeRunners = (directRegion.match(/interruptAll\?\./g) ?? []).length;
  const interruptsBeforeGroup = (groupRegion.match(/interruptAll\?\./g) ?? []).length;

  assert.ok(
    interruptsBeforeRunners >= 1,
    "dispose clears the runners without ever interrupting them, so a live shell and its children outlive the host on shutdown",
  );
  assert.ok(
    interruptsBeforeGroup >= 1,
    "dispose clears the group-member runners without interrupting them, so a group room turn survives the app closing",
  );
});

// ---------------------------------------------------------------------------
// 5. A real command, a real child, and both shown gone.
// ---------------------------------------------------------------------------

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to somebody else.
    return error?.code === "EPERM";
  }
}

function killTreeSync(pid) {
  spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true, timeout: 5_000 });
}

async function waitFor(predicate, { timeoutMs, what }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

test("a real long-running command stops, and the process it started is gone with it", { timeoutMs: 120_000 }, async () => {
  const core = await bundle([
    ["packages", "local-exec", "shell-core.ts"],
    ["packages", "shell-exec", "naive.ts"],
    ["packages", "context", "core.ts"],
  ]);
  const work = mkdtempSync(path.join(os.tmpdir(), "grok-stop-tree-"));
  const pidFile = path.join(work, "grandchild.pid");
  const middlePidFile = path.join(work, "middle.pid");
  const grandchildFile = path.join(work, "grandchild.cjs");
  const middleFile = path.join(work, "middle.cjs");

  // Three levels, because one level cannot show the defect. The shell is the
  // process whose pid the guard is handed, and what the tree walk exists for is
  // everything BELOW it: `child.kill()` on Windows is a TerminateProcess on one
  // pid, so `cmd.exe` dies and the `node` it started keeps running. That is the
  // exact leak this project already hit once.
  //
  // The scripts are written as files and invoked by an unquoted absolute path
  // because `cmd.exe /c` does not strip a nested pair of quotes, and the temp
  // directory name carries no spaces on either host.
  writeFileSync(
    grandchildFile,
    `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`,
  );
  writeFileSync(
    middleFile,
    `require("fs").writeFileSync(${JSON.stringify(middlePidFile)}, String(process.pid)); require("child_process").spawn(process.execPath, [${JSON.stringify(grandchildFile)}], { stdio: "ignore" }); setInterval(() => {}, 1000);\n`,
  );

  const { BaseShellCoreExecutor } = core.loaded["shell-core.mjs"];
  const { createNaiveTerminalExecutor } = core.loaded["naive.mjs"];
  const { createContext } = core.loaded["core.mjs"];

  const executor = createNaiveTerminalExecutor({ shell: "cmd.exe" });
  const shell = new BaseShellCoreExecutor(executor, work, work);
  const turn = new AbortController();

  // The pid the executor reports through `stdin_ready` is the one the guard names
  // the tree by, so it is captured rather than assumed.
  let shellPid;
  let middlePid;
  let grandchildPid;
  try {
    const drained = (async () => {
      const seen = [];
      for await (const event of shell.execute(createContext(), {
        command: `node ${middleFile}`,
        workingDirectory: work,
        signal: turn.signal,
      })) {
        if (event.type === "stdin_ready") shellPid = event.pid;
        seen.push(event);
      }
      return seen;
    })();

    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0, {
      timeoutMs: 30_000,
      what: "the innermost child to report its pid",
    });
    grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
    middlePid = existsSync(middlePidFile) ? Number(readFileSync(middlePidFile, "utf8").trim()) : undefined;

    await waitFor(() => shellPid !== undefined, { timeoutMs: 30_000, what: "the shell to report its pid" });
    assert.equal(alive(shellPid), true, "the shell is not running, so the abort below proves nothing");
    assert.equal(alive(grandchildPid), true, "the child is not running, so nothing below can show that the tree is walked");

    turn.abort({ intentional: true, reason: "the user pressed stop" });

    // Bounded on purpose. A leaked process inherits the shell's stdout pipe, and a
    // stream that never closes would hang this file instead of failing it — which
    // is the defect under test turning the proof into a freeze. The timer is
    // cleared on both paths, because an uncleared one holds the event loop for its
    // full thirty seconds after a run that finished in three hundred.
    let raceTimer;
    const settled = await Promise.race([
      drained,
      new Promise((_resolve, reject) => {
        raceTimer = setTimeout(
          () => reject(new Error("the shell stream never ended after the abort, so a process the stop should have killed is still holding it open")),
          30_000,
        );
      }),
    ]).finally(() => clearTimeout(raceTimer));

    assert.ok(
      settled.some((event) => event.type === "exit"),
      "the abort produced no exit, so the turn is still waiting on a command the user stopped",
    );

    await waitFor(() => !alive(grandchildPid), { timeoutMs: 30_000, what: "the child process to be gone" });
    assert.equal(alive(grandchildPid), false, "the shell died and the process it started kept running, which is the leak the tree walk exists to close");
    assert.equal(alive(shellPid), false, "the shell outlived the abort, so the turn would still be blocked on it");
  } finally {
    // The cleanup walks the tree from the middle process for the same reason the
    // guard does. When this test runs against a build that does not walk it, the
    // thing it has just proved is running is exactly what would be left behind —
    // and it still holds this process's stdout pipe open, so a test that merely
    // waited on the stream would hang instead of failing.
    turn.abort();
    for (const pid of [shellPid, middlePid, grandchildPid]) {
      if (pid !== undefined && alive(pid)) killTreeSync(pid);
    }
    core.dispose();
    rmSync(work, { recursive: true, force: true });
  }
});