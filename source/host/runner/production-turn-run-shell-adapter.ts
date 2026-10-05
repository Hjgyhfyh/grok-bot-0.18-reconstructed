import type { Context } from "../../packages/context/core.js";
import { sandTurnDirectionEpochKey } from "../../shared/local-tool-permission-machinery.js";
import type {
  ConversationStateStructure as ConversationStateStructureMessage,
} from "../../packages/proto/generated/agent/v1/agent_pb.js";
import {
  createProductionTurnAgentOwner,
  createProductionTurnAgentRunInput,
  type ProductionTurnAgentOwner,
  type ProductionTurnAgentOwnerInput,
  type ProductionTurnAgentRunInput,
} from "./production-turn-agent-owner.js";
import { createTurnAgentStreamStart } from "./turn-agent-composition.js";
import {
  createTurnRunShell,
  type PreparedTurn,
  type TurnRunContext,
  type TurnRunOptions,
  type TurnRunShellHost,
  type TurnStreamCallbacks,
} from "./turn-run-shell.js";
import type {
  TurnCheckpoint,
  TurnSession,
  TurnSettleHost,
} from "./turn-settle.js";
import type {
  GeneratedTurnPromptOptions,
} from "./prompt-collector-glue.js";
import type { TurnAgentMcpTurnProvider } from "./turn-agent-composition.js";
import { createStreamAttempt } from "./stream-attempt.js";
import type { RetryPolicy } from "./transient-stream-error.js";
import type { ForwardedUpdate } from "./agent-adapters.js";

/**
 * What the attempt layer reports about one retry ladder. The production shell
 * has no tray/telemetry sink bound to it, so this is the only honest way for a
 * host that wants to see retries to say so; absent, the ladder still counts and
 * still resumes.
 */
export interface ProductionTurnStreamRetryReport {
  readonly outcome: "retried" | "exhausted" | "gave_up_ineligible";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs?: number;
  readonly error?: unknown;
}

/**
 * Updates that mean the model stream has produced something. This is the same
 * set `SandAgentRunner.emitUpdate` uses to clear a first-token stall deadline,
 * plus the delivery updates: once the user (or a tool result) has been written,
 * a "nothing came back yet" deadline would be a lie.
 */
const STREAM_OUTPUT_PRODUCED_TYPES: ReadonlySet<string> = new Set([
  "text-delta",
  "thinking-delta",
  "tool-call",
  "send-message",
  "react-to-message",
]);

/**
 * The first-token stall timer the attempt layer arms. This is the ten lines
 * `SandAgentRunner.createDeadlineTimer` already is — the attempt layer needs a
 * timer factory and the production shell does not carry one, so it supplies the
 * same shape here. It is a timer, not a policy: the deadline, the ceiling and
 * the doubling stay owned by `transient-stream-error.ts`.
 */
function createAttemptDeadlineTimer(
  fire: () => void,
  milliseconds: number,
): { cancel(): void; restart(): void } {
  let timer = setTimeout(fire, milliseconds);
  timer.unref?.();
  return {
    cancel: () => clearTimeout(timer),
    restart: () => {
      clearTimeout(timer);
      timer = setTimeout(fire, milliseconds);
      timer.unref?.();
    },
  };
}

export interface ProductionTurnRunShellPreparedTurn extends PreparedTurn {
  readonly baseState: ConversationStateStructureMessage;
  readonly productionOwner: ProductionTurnAgentOwner;
  readonly productionInput: Awaited<
    ReturnType<typeof createProductionTurnAgentRunInput>
  >;
  readonly runContext: Context;
  readonly disposeRunContext: () => void;
  /** The shell generation this turn was prepared under; a stale turn persists nothing. */
  readonly generation: number;
  /** Hidden turns stay silent: no retry is announced to a surface nobody is watching. */
  readonly hidden: boolean;
  readonly transientStreamRetry?: RetryPolicy;
  readonly updateRelay: {
    callbacks?: TurnStreamCallbacks;
    prepared?: ProductionTurnRunShellPreparedTurn;
  };
}

function linkTurnRunContext(
  base: Context,
  signal: AbortSignal,
): { readonly context: Context; readonly dispose: () => void } {
  const [context, cancel] = base.withCancel();
  const abort = () => cancel(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return {
    context,
    dispose: () => signal.removeEventListener("abort", abort),
  };
}

/**
 * The two live methods a turn needs from the local-tool-permission controller.
 *
 * Only these two, deliberately: the turn opens a direction and reads its
 * number. Everything else the controller owns (pending asks, standing
 * approvals, remembered refusals) keeps its own implementation and is reached
 * through the narrower toolset projection.
 */
export interface TurnLocalToolPermissionEpoch {
  beginTurn(agentId: string): void;
  directionEpoch(agentId: string): number;
}

/**
 * The direction epoch ONE turn runs under.
 *
 * The 0.18 build wrote this expression exactly once per turn, into the turn's
 * context, and every later read came out of the context:
 *
 *   host.isSubagentRunner
 *     ? host.inheritedDirectionEpoch
 *     : host.localToolPermission.directionEpoch(host.getConversationId())
 *
 * Nothing in `source/` ever wrote that key — `withLocalToolScope` read it on
 * every scoped tool call and it was always absent, so `scope.directionEpoch`
 * stayed `undefined` and the controller fell back to `this.directionEpoch(agentId)`,
 * which is 0 until something calls `beginTurn`. With nothing calling
 * `beginTurn`, that fallback was 0 for the life of the process.
 *
 * A subagent inherits rather than opens: a child has its own agent id, so its
 * own map entry is 0 by construction, and a child that started a fresh
 * direction would forget the parent's refusal for the same task — the exact
 * thing `SAND_LOCAL_TOOLS_ABANDONED_MESSAGE` tells the model is permanent.
 *
 * Absent permission controller, or a subagent with nothing to inherit, means
 * `undefined`: the context keeps the key's own `undefined` default, the scoped
 * tool call omits `directionEpoch` from its scope, and the controller applies
 * its own fallback. That is the pre-existing behaviour, unchanged.
 */
function resolveTurnDirectionEpoch(
  input: ProductionTurnRunShellAdapterInput,
): number | undefined {
  const permission = input.localToolPermission;
  if (permission === undefined) return undefined;
  if (input.isSubagentRunner && input.inheritedDirectionEpoch !== undefined) {
    return input.inheritedDirectionEpoch;
  }
  return permission.directionEpoch(input.getConversationId());
}

/** Exact host inputs around the existing turn-run-shell lifecycle. */
export interface ProductionTurnRunShellAdapterInput {
  readonly createOwner: (input: {
    readonly requestId: string;
    readonly runOptions: TurnRunOptions;
    readonly context: Context;
    readonly cancelThisRun: ProductionTurnAgentOwner["runContext"]["scope"]["cancelThisRun"];
    readonly emitUpdate: (update: ForwardedUpdate) => void;
  }) => Promise<ProductionTurnAgentOwner>;
  readonly createRunInput: (input: {
    readonly owner: ProductionTurnAgentOwner;
    readonly runContext: Context;
    readonly prompt: string;
    readonly options: GeneratedTurnPromptOptions;
  }) => Promise<Awaited<ReturnType<typeof createProductionTurnAgentRunInput>>>;
  readonly promptOptions: (
    prompt: string,
    options: TurnRunOptions,
  ) => GeneratedTurnPromptOptions;
  readonly createSession: (owner: ProductionTurnAgentOwner) => TurnSession;
  readonly context: () => Context;
  readonly createSettleHost: () => TurnSettleHost;
  readonly profilePromptSnapshots: () => unknown;
  readonly isSubagentRunner: boolean;
  readonly subagentType?: string;
  readonly inheritedRequestSource?: string;
  readonly inheritedAutomationId?: string;
  readonly subagents: TurnRunShellHost["subagents"];
  readonly getConversationId: () => string;
  /**
   * The live local-tool-permission controller, when the host bound one.
   *
   * It is optional because the permission extension is optional: an agent with
   * no permission surface at all must still run, and a turn that finds no
   * controller here carries no epoch rather than failing.
   *
   * Bind it together with `beginLocalToolPermissionTurn` below — the turn opens
   * a direction through one and reads its number through the other.
   */
  readonly localToolPermission?: TurnLocalToolPermissionEpoch;
  /**
   * Opens the next direction for a conversation, once per turn.
   *
   * `turn-run-shell.ts` declares this hook and calls it before the turn is
   * prepared; nothing implemented it, so `directionEpochs` stayed empty and
   * every remembered refusal stayed stamped with epoch 0 forever.
   */
  readonly beginLocalToolPermissionTurn?: (conversationId: string) => void;
  /**
   * The parent's direction epoch, for a subagent.
   *
   * A subagent must never read its own number: its agent id is not in the
   * controller's map, so `directionEpoch(childId)` is 0 even while the parent
   * is several turns deep. It inherits instead.
   */
  readonly inheritedDirectionEpoch?: number;
  readonly runGeneration: () => number;
  readonly setActiveTurnRequestSource: (source: string | undefined) => void;
  readonly setActiveTurnAutomationId?: (automationId: string | undefined) => void;
  readonly beginAutoReviewUserMessageEpoch: () => void;
  readonly setActiveRunInterrupted: (value: boolean) => void;
  readonly setAwaitingUserSelection: (value: boolean) => void;
  readonly isAwaitingUserSelection: () => boolean;
  readonly emitRunLifecycle: TurnRunShellHost["emitRunLifecycle"];
  readonly emitUpdate: (update: ForwardedUpdate) => void;
  readonly lastReactionApplied?: () => boolean;
  readonly cancelThisRun: ProductionTurnAgentOwner["runContext"]["scope"]["cancelThisRun"];
  readonly onRunUnwind?: () => void;
  /** Optional sink for the retry ladder's report; absent means silence, not a different policy. */
  readonly onStreamRetry?: (report: ProductionTurnStreamRetryReport) => void;
}

/**
 * Concrete turn-side inputs for the production shell lifecycle.
 *
 * This is intentionally expressed in terms of the real owner inputs rather
 * than a preassembled adapter object: one call creates the Agent owner, and
 * one prepared turn creates the generated action/MCP/state projection. The
 * host remains responsible only for supplying its live service identities
 * and lifecycle callbacks.
 */
export interface ProductionTurnRunShellHostInput extends Omit<
  ProductionTurnRunShellAdapterInput,
  "createOwner" | "createRunInput" | "promptOptions"
> {
  readonly createAgentOwnerInput: (input: {
    readonly requestId: string;
    readonly runOptions: TurnRunOptions;
    readonly context: Context;
    readonly cancelThisRun: ProductionTurnAgentOwnerInput["cancelThisRun"];
    readonly emitUpdate: ProductionTurnAgentOwnerInput["emitUpdate"];
  }) => ProductionTurnAgentOwnerInput;
  readonly promptOptions: (
    prompt: string,
    options: TurnRunOptions,
  ) => GeneratedTurnPromptOptions;
  readonly assembleGeneratedTurnAction: ProductionTurnAgentRunInput["assembleGeneratedTurnAction"];
  readonly compactionEpoch: ProductionTurnAgentRunInput["compactionEpoch"];
  readonly getConversationState: ProductionTurnAgentRunInput["getConversationState"];
  readonly mcp?: TurnAgentMcpTurnProvider;
  readonly onMcpDiscoveryFailed?: ProductionTurnAgentRunInput["onMcpDiscoveryFailed"];
}

/**
 * Joins the real prompt/action/state/session owners to the existing shell
 * lifecycle. No adapter callbacks are accepted from the caller: this owner
 * constructs them from the concrete Agent owner and generated turn producer.
 */
export function createProductionTurnRunShellHostInput(
  input: ProductionTurnRunShellHostInput,
): ProductionTurnRunShellAdapterInput {
  const {
    createAgentOwnerInput,
    assembleGeneratedTurnAction,
    compactionEpoch,
    getConversationState,
    mcp,
    onMcpDiscoveryFailed,
    promptOptions,
    ...lifecycle
  } = input;
  return {
    ...lifecycle,
    promptOptions,
    createOwner: async ({
      requestId,
      runOptions,
      context,
      cancelThisRun,
      emitUpdate,
    }) => createProductionTurnAgentOwner({
      ...createAgentOwnerInput({
        requestId,
        runOptions,
        context,
        cancelThisRun,
        emitUpdate,
      }),
      context,
      requestId,
      cancelThisRun,
      emitUpdate,
    }),
    createRunInput: async ({ owner, runContext, prompt, options }) =>
      createProductionTurnAgentRunInput({
        runCtx: runContext,
        trimmedPrompt: prompt.trim(),
        promptOptions: options,
        assembleGeneratedTurnAction,
        ...(owner.runContext.profileUpdateForTurn === undefined
          ? {}
          : { profileUpdateForTurn: owner.runContext.profileUpdateForTurn }),
        compactionEpoch,
        getConversationState,
        ...(mcp === undefined ? {} : { mcp }),
        ...(onMcpDiscoveryFailed === undefined
          ? {}
          : { onMcpDiscoveryFailed }),
      }),
  };
}

function cloneBaseTurnCheckpoint(
  state: ConversationStateStructureMessage,
): ConversationStateStructureMessage {
  return state.clone();
}

/**
 * Binds the recovered Agent owner to turn-run-shell. Retry, accepted
 * checkpoint capture, generation gates, quiesce, final settle, and cleanup
 * remain owned by the existing lifecycle; this module only supplies its
 * three missing host methods.
 */
export function createProductionTurnRunShellAdapter(
  input: ProductionTurnRunShellAdapterInput,
) {
  const prepared = new WeakMap<object, ProductionTurnRunShellPreparedTurn>();
  let activeOwner: ProductionTurnAgentOwner | undefined;
  let activePrepared: ProductionTurnRunShellPreparedTurn | undefined;
  let streamOutputProduced = false;
  let attemptDeadlineHooks:
    | { disarm: () => void; reset: () => void }
    | undefined;
  // A turn with no permission controller simply has no method on the host,
  // which is exactly what the shell's optional call expects.
  const beginLocalToolPermissionTurn = input.beginLocalToolPermissionTurn;
  const host: TurnRunShellHost = {
    isSubagentRunner: input.isSubagentRunner,
    ...(input.subagentType === undefined ? {} : { subagentType: input.subagentType }),
    ...(input.inheritedRequestSource === undefined
      ? {}
      : { inheritedRequestSource: input.inheritedRequestSource }),
    ...(input.inheritedAutomationId === undefined
      ? {}
      : { inheritedAutomationId: input.inheritedAutomationId }),
    subagents: input.subagents,
    getConversationId: input.getConversationId,
    runGeneration: input.runGeneration,
    setActiveTurnRequestSource: input.setActiveTurnRequestSource,
    ...(input.setActiveTurnAutomationId === undefined
      ? {}
      : { setActiveTurnAutomationId: input.setActiveTurnAutomationId }),
    ...(beginLocalToolPermissionTurn === undefined
      ? {}
      : { beginLocalToolPermissionTurn }),
    beginAutoReviewUserMessageEpoch: input.beginAutoReviewUserMessageEpoch,
    setActiveRunInterrupted: input.setActiveRunInterrupted,
    setAwaitingUserSelection: input.setAwaitingUserSelection,
    isAwaitingUserSelection: input.isAwaitingUserSelection,
    emitRunLifecycle: input.emitRunLifecycle,
    async prepareTurn(
      prompt: string,
      options: TurnRunOptions,
      context: TurnRunContext,
    ): Promise<PreparedTurn> {
      // The single write of the direction epoch for this turn. Everything
      // downstream — the Agent owner, the MCP provider, the stream, and every
      // `withLocalToolScope` tool call — reads it back out of this context, so
      // the number cannot drift between two lookups of the live controller.
      const directionEpoch = resolveTurnDirectionEpoch(input);
      const turnBase = directionEpoch === undefined
        ? input.context()
        : input.context().with(sandTurnDirectionEpochKey, directionEpoch);
      const linked = linkTurnRunContext(turnBase, context.signal);
      const updateRelay: ProductionTurnRunShellPreparedTurn["updateRelay"] = {};
      const emitUpdate = (update: ForwardedUpdate): void => {
        if (STREAM_OUTPUT_PRODUCED_TYPES.has(update.type) && !streamOutputProduced) {
          streamOutputProduced = true;
          attemptDeadlineHooks?.disarm();
          attemptDeadlineHooks = undefined;
        }
        const callbacks = activePrepared === updateRelay.prepared
          ? updateRelay.callbacks
          : undefined;
        if (callbacks !== undefined) {
          if (update.type === "text-delta" && typeof update.text === "string") {
            callbacks.collectText(update.text);
          } else if (update.type === "send-message") {
            callbacks.collectSendMessage();
            const message = update.message;
            if (
              typeof message === "object"
              && message != null
              && Reflect.get(message, "type") === "text"
              && typeof Reflect.get(message, "content") === "string"
            ) {
              callbacks.collectAgentMessage(Reflect.get(message, "content"));
            }
          }
        }
        input.emitUpdate(update);
        if (
          callbacks !== undefined
          && update.type === "react-to-message"
          && input.lastReactionApplied?.() === true
        ) {
          callbacks.collectReaction();
        }
      };
      try {
        const owner = await input.createOwner({
          requestId: context.requestId,
          runOptions: options,
          context: linked.context,
          cancelThisRun: input.cancelThisRun,
          emitUpdate,
        });
        const productionInput = await input.createRunInput({
          owner,
          runContext: linked.context,
          prompt,
          options: input.promptOptions(prompt, options),
        });
        const result: ProductionTurnRunShellPreparedTurn = {
          action: productionInput.action,
          baseState: cloneBaseTurnCheckpoint(productionInput.baseState),
          transcriptPersistenceEnabled: true,
          session: input.createSession(owner),
          productionOwner: owner,
          productionInput,
          runContext: linked.context,
          disposeRunContext: linked.dispose,
          generation: context.generation,
          hidden: options.hidden === true,
          ...(options.transientStreamRetry === undefined
            ? {}
            : { transientStreamRetry: options.transientStreamRetry }),
          updateRelay,
        };
        updateRelay.prepared = result;
        activeOwner = owner;
        activePrepared = result;
        prepared.set(result, result);
        return result;
      } catch (error) {
        linked.dispose();
        throw error;
      }
    },
    async runPreparedTurn(
      preparedTurn: PreparedTurn,
      context: TurnRunContext,
      callbacks: TurnStreamCallbacks,
    ): Promise<TurnCheckpoint> {
      const owned = prepared.get(preparedTurn);
      if (owned === undefined) {
        throw new TypeError("production turn prepared owner is not bound");
      }
      owned.updateRelay.callbacks = callbacks;
      const stream = createTurnAgentStreamStart({
        agent: owned.productionOwner.built,
        baseState: owned.baseState,
        action: owned.productionInput.action,
        privacyMode: owned.productionOwner.runContext.privacyMode,
        mcpTools: owned.productionInput.mcpTools,
      });
      // The retry ladder owns the resume point.
      //
      // This used to call `stream.startStream(runContext, undefined, …)` once.
      // `undefined` was the whole defect: `createStreamAttempt` computes the
      // last ACCEPTED checkpoint on a retry and hands it to `startStream` as the
      // second argument, but no ladder was ever built here, so a transient
      // provider fault ended the turn instead of continuing it — every step the
      // model had already produced and the shell had already persisted was
      // thrown away with the failed stream.
      //
      // `createStreamAttempt` is now the single owner of that decision: it is
      // the same module `stream-retry-ladder.test.mjs` already exercises, and
      // `inactive-turn-agent-stream.ts` already binds it the same way. The
      // resume point it computes is forwarded BY IDENTITY into
      // `createTurnRedactedRunProjection`, which swaps the user-message action
      // for `RESUME_TURN_ACTION` and rebuilds the state from the checkpoint —
      // so a retry continues the turn instead of starting it over.
      const finalState = await createStreamAttempt<
        Context,
        ConversationStateStructureMessage,
        ConversationStateStructureMessage
      >({
        ctx: owned.runContext,
        hidden: owned.hidden,
        ...(owned.transientStreamRetry === undefined
          ? {}
          : { transientStreamRetry: owned.transientStreamRetry }),
        setStreamOutputProduced: (value) => {
          streamOutputProduced = value;
        },
        getStreamOutputProduced: () => streamOutputProduced,
        async persistCheckpoint(_checkpointCtx, checkpoint, accepted) {
          // A superseded generation owns nothing: not the write, and not the
          // claim that this checkpoint may be resumed from.
          if (input.runGeneration() !== owned.generation) return;
          await callbacks.persistCheckpoint(checkpoint);
          accepted(checkpoint);
        },
        startStream: (attemptCtx, resumeFrom, persist) =>
          stream.startStream(attemptCtx, resumeFrom, persist),
        createDeadlineTimer: createAttemptDeadlineTimer,
        setDeadlineHooks: (disarm, reset) => {
          attemptDeadlineHooks = { disarm, reset };
        },
        clearDeadlineHookIf: (disarm, reset) => {
          if (attemptDeadlineHooks?.disarm === disarm
            && attemptDeadlineHooks.reset === reset) {
            attemptDeadlineHooks = undefined;
          }
        },
        setTraceAttributes: () => {
          // No tracing sink is bound to the production shell today. The ladder
          // still counts the retry; only the span attribute is dropped.
        },
        emitRetrying: () => {
          // Hidden turns and automation turns stay silent here: neither has a
          // surface to announce a retry to, and the ladder's own report below
          // is the record.
        },
        reportTurnRetry: (report) => input.onStreamRetry?.(report),
      }).run();
      owned.productionOwner.runContext.commitDiskPressureReminder();
      return finalState;
    },
    createSettleHost: input.createSettleHost,
    profilePromptSnapshots: input.profilePromptSnapshots,
    onRunUnwind: () => {
      const owner = activeOwner;
      activeOwner = undefined;
      if (activePrepared !== undefined) {
        delete activePrepared.updateRelay.callbacks;
      }
      // The stream context is linked to the shell controller and must not
      // retain the outer run's abort listener after owner disposal.
      activePrepared?.disposeRunContext();
      activePrepared = undefined;
      owner?.dispose();
      input.onRunUnwind?.();
    },
  };
  return createTurnRunShell(host);
}
