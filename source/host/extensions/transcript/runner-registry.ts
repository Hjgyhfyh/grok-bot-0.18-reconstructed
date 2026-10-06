import { findBackendConnectError } from "./agent-run-error.js";
import { createSandTransport } from "../../ports/transport.js";
import { sandErrorWireCode } from "../../../shared/errors/registry.js";
import { classifyAgentError, connectCodeOf } from "./turn-runtime.js";
import {
  RUNNER_UNATTACHED_MESSAGE,
  type TranscriptManagerLike,
} from "./transcript-hub.js";

export class SandRemoteRoomError extends Error {}

export function coarseErrorTypeAndCode(error: unknown): {
  errorType: string;
  errorCode?: string;
} {
  const connectError = findBackendConnectError(error, false);
  if (connectError != null) {
    const errorCode = connectCodeOf(error);
    return {
      errorType: "connect_error",
      ...(errorCode == null ? {} : { errorCode }),
    };
  }
  if (error instanceof Error)
    return { errorType: error.name.length > 0 ? error.name : "error" };
  return { errorType: "unknown" };
}

export class RunnerRegistry {
  readonly runners = new Map<string, any>();
  readonly activeGroupMemberRunners = new Map<string, any>();

  constructor(readonly tm: TranscriptManagerLike) {}

  interruptWedgedRunForWatchdog(agentId: string): boolean {
    const reason = "run-queue watchdog: releasing a wedged predecessor";
    const wasInFlight = this.tm.runLifecycle.runningAgentIds().has(agentId);
    const hadActiveGroupMemberRun =
      this.activeGroupMemberRunners.get(agentId)?.interrupt(reason) ?? false;
    const hadActiveRun =
      (this.runners.get(agentId)?.interrupt(reason) ?? false) ||
      hadActiveGroupMemberRun;
    this.tm.telemetry.reportTurnInterrupt({
      conversationId: agentId,
      reason: "watchdog",
      hadActiveRun,
      wasInFlight,
    });
    return hadActiveRun;
  }

  /**
   * The user's own stop, for one agent.
   *
   * `interruptAll` is the one primitive that reaches everything a turn owns: the
   * foreground run, plus every subagent session it dispatched
   * (`SandAgentRunner.interruptAll` at source/host/runner/sand-agent-runner.ts:1201
   * walks `subagents.sessions` after aborting the active run). Everything the
   * stop needs downstream hangs off that one abort — the model stream, a waiting
   * permission ask, a running shell's process tree — so this deliberately adds no
   * second path of its own.
   *
   * It reads the two maps and never calls `getRunner`. Creating a runner for an
   * agent that has never run would be a side effect of asking whether it was
   * busy, and the answer has to be safe to give for an agent that is not.
   *
   * The two reported facts are read at different moments on purpose.
   * `hadRunningSubagents` is measured BEFORE the interrupt, because that is the
   * only moment at which it means anything: afterwards every subagent is aborting
   * whether or not it ever was running, and the same `false` would be returned
   * for "stopped three subagents" and for "there was nothing to stop".
   * `interrupted` is `interruptAll`'s own return, which is true only when an
   * active run actually took the abort. `interruptAll` returns that single flag
   * and says nothing about its subagent loop, so the two are reported apart
   * rather than folded into one "did it work" boolean that cannot mean it.
   */
  interruptUserRun(
    agentId: string,
    reason: string,
  ): { interrupted: boolean; hadRunningSubagents: boolean } {
    const runner = this.runners.get(agentId);
    const groupRunner = this.activeGroupMemberRunners.get(agentId);
    if (runner == null && groupRunner == null) {
      return { interrupted: false, hadRunningSubagents: false };
    }
    const hadRunningSubagents =
      (runner?.hasRunningSubagents?.() === true) ||
      (groupRunner?.hasRunningSubagents?.() === true);
    // Both runners are called, unconditionally, before the flags are combined.
    // A single `a || b` here would short-circuit: an agent with a live
    // direct-chat runner would answer `true` and the group-member runner would
    // never be asked, so the stop stopped the direct turn and left the group room
    // talking. Both ids can be live at once — `group-chat-glue.ts` files the
    // member runner under the member's own agent id — and a stop that reaches one
    // of them is a stop that does not reach the room the user is watching.
    const interruptedOwnRun = runner?.interruptAll?.(reason) === true;
    const interruptedGroupRun = groupRunner?.interruptAll?.(reason) === true;
    return { interrupted: interruptedOwnRun || interruptedGroupRun, hadRunningSubagents };
  }

  attachRunner(runner: any): void {
    this.tm.attachRunnerFactory((session: any, hooks: any) => {
      runner.setAgentStore(session.agentStore, hooks.agentProfileProvider);
      runner.setMemoryStore(session.memory);
      runner.setMemorySnapshotStore(session.db);
      runner.setProfilePromptSnapshotStore(session.db);
      runner.setEpisodeProgress(session.db);
      runner.setAutomationStore(session.automations);
      runner.setWorkflowStore(session.workflows);
      runner.setChannelStore(session.channels);
      runner.setAttachmentIngestor(hooks.ingestAttachment);
      runner.setImagePersister(hooks.persistImage);
      runner.setMediaBytesPersister(hooks.persistMediaBytes);
      runner.setAgentIdProvider(() => session.id);
      return runner;
    });
  }

  attachRunnerFactory(factory: (...args: any[]) => any): void {
    this.tm.setTurnExecution({
      ...this.tm.execution,
      canExecute: true,
      createRunner: (session: any, hooks: any) => factory(session, hooks),
    });
  }
  attachGroupMemberRunnerFactory(factory: (...args: any[]) => any): void {
    this.tm.setTurnExecution({
      ...this.tm.execution,
      canExecuteGroupMember: true,
      createGroupMemberRunner: (session: any, hooks: any, overrides: any) =>
        factory(session, hooks, overrides),
    });
  }
  attachRunReadinessProbe(probe: () => Promise<boolean>): void {
    this.tm.setTurnExecution({ ...this.tm.execution, isRunReady: probe });
  }
  async isRunReady(): Promise<boolean> {
    return this.tm.execution.isRunReady();
  }

  getRunner(session: any): any {
    if (this.tm.groupChat.isRemoteRoomSession(session))
      throw new SandRemoteRoomError(
        "This is a shared chat hosted by another user; it has no local agent to run.",
      );
    const cached = this.runners.get(session.id);
    if (cached != null) {
      if (this.tm.upgradeResume.quiescingForUpgrade)
        cached.requestQuiesceForUpgrade();
      return cached;
    }
    if (!this.tm.execution.canExecute)
      throw new Error(RUNNER_UNATTACHED_MESSAGE);
    const runner = this.tm.execution.createRunner(
      session,
      this.runnerHooksFor(session),
    );
    this.wireRunnerLifecycle(runner, session, session.id);
    this.runners.set(session.id, runner);
    return runner;
  }

  createGroupMemberRunner(
    session: any,
    transport: unknown,
    overrides: unknown,
  ): any {
    if (!this.tm.execution.canExecuteGroupMember)
      throw new Error(RUNNER_UNATTACHED_MESSAGE);
    const runner = this.tm.execution.createGroupMemberRunner(
      session,
      this.runnerHooksFor(session, transport),
      overrides,
    );
    this.wireRunnerLifecycle(runner, session, session.id);
    return runner;
  }

  wireRunnerLifecycle(
    runner: any,
    session: any,
    ttftConversationId: string,
  ): any {
    if (this.tm.upgradeResume.quiescingForUpgrade)
      runner.requestQuiesceForUpgrade();
    runner.setBackgroundSubagentHandler((completion: unknown) =>
      this.tm.backgroundWakes.handleBackgroundSubagentCompletion(completion),
    );
    runner.setBackgroundSubagentDispatchHandler((dispatch: any) =>
      this.tm.productAnalytics.trackEvent("sand.subagent.dispatched", {
        parent_agent_id: dispatch.parentAgentId,
        subagent_agent_id: dispatch.subagentAgentId,
        subagent_type: dispatch.subagentType,
        tool_call_id: dispatch.toolCallId,
        subagent_request_id: dispatch.subagentRequestId,
      }),
    );
    runner.setComputerUseUsageHandler((report: any) => {
      const usage = report.usage;
      this.tm.productAnalytics.trackEvent("sand.computer_use.usage", {
        parent_agent_id: report.parentAgentId,
        subagent_agent_id: report.subagentAgentId,
        subagent_type: report.subagentType,
        subagent_request_id: report.subagentRequestId,
        outcome: report.outcome,
        duration_ms: report.durationMs,
        tool_call_count: report.toolCallCount,
        turn_ended_count: report.turnEndedCount,
        has_usage: usage != null,
        ...(report.modelId == null ? {} : { model_id: report.modelId }),
        ...(usage == null
          ? {}
          : {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cache_read_tokens: usage.cacheReadTokens,
              cache_write_tokens: usage.cacheWriteTokens,
              ...(usage.reasoningTokens == null
                ? {}
                : { reasoning_tokens: usage.reasoningTokens }),
            }),
      });
      this.tm.telemetry.reportComputerUseUsage(report);
    });
    runner.setSubagentEventHandler((event: unknown) =>
      this.tm.roster.emitSubagents(runner, event),
    );
    runner.setAsyncTasksEventHandler((event: unknown) =>
      this.tm.roster.emitAsyncTasks(runner, event),
    );
    runner.setBackgroundShellHandler((completion: unknown) =>
      this.tm.backgroundWakes.handleBackgroundShellCompletion(completion),
    );
    runner.setPendingWakeArmedHandler((event: unknown) =>
      this.tm.pendingWakes.persistPendingWake(event),
    );
    runner.setPendingWakeDisarmedHandler((event: unknown) =>
      this.tm.pendingWakes.disarmPendingWake(event),
    );
    runner.setTurnAwaitHandler((observation: unknown) =>
      this.tm.telemetry.reportTurnAwait({
        conversationId: session.id,
        ...(observation as object),
      }),
    );
    runner.setFirstTokenHandler((observation: unknown) =>
      this.tm.telemetry.reportTtft({
        conversationId: ttftConversationId,
        ...(observation as object),
      }),
    );
    runner.setSendDispatchHandler((observation: unknown) =>
      this.tm.telemetry.reportSendDispatch({
        conversationId: session.id,
        ...(observation as object),
      }),
    );
    runner.setTurnRetryHandler(({ error, ...rest }: any) => {
      const { errorType, errorCode } = coarseErrorTypeAndCode(error);
      this.tm.telemetry.reportTurnRetry({
        conversationId: session.id,
        ...rest,
        errorType,
        ...(errorCode == null ? {} : { errorCode }),
        cause: sandErrorWireCode(classifyAgentError(error)),
      });
    });
    runner.setToolCallDiagnosticHandler((observation: unknown) =>
      this.tm.turnRuntime.reportToolCallDiagnostic(session, observation),
    );
    return runner;
  }

  runnerHooksFor(session: any, transport?: unknown): Record<string, unknown> {
    return {
      transport:
        transport ??
        createSandTransport((update) =>
          this.tm.handleAgentUpdate(update, session),
        ),
      onRunLifecycle: (event: unknown) => this.tm.emitAgentRunLifecycle(event),
      ingestAttachment: this.tm.createAttachmentIngestor(session),
      persistImage: this.tm.createAssetImagePersister(session),
      persistMediaBytes: this.tm.createMediaBytesPersister(session),
      agentProfileProvider: () => this.tm.roster.resolveAgentProfile(session),
    };
  }
}
