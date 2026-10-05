import { dirname } from "node:path";
import { TranscriptMirrorOffloadPool } from "./agent-isolation/transcript-mirror-offload.js";
import type {
  CreateProductionRunnerRunStep,
  ProductionTurnHostDependencies,
  ProductionTurnHostToolProjections,
  ProductionTurnAutoReviewHostProjection,
  ProductionTurnCancelThisRun,
  ProductionTurnExternalAwaitInputs,
  ProductionTurnEmitUpdate,
  ProductionTurnToolInputs,
} from "./runner-production-bridge.js";
import {
  createProductionTurnToolInputs,
  createProductionTurnToolsetHost,
  type ProductionTurnToolsetHostInput,
} from "./runner-production-bridge.js";
import { NoopConversationActionReceiver } from "../packages/agent-core/conversation-actions/remote.js";
import {
  RequestContext,
  RequestContextEnv,
} from "../packages/proto/generated/agent/v1/request_context_exec_pb.js";
import {
  SummarizationHandler,
  type SummarizationPromptSession,
} from "../packages/agent-summarization/summarization-handler.js";
import { getAgentBlobStore } from "./runner/sand-agent-runner.js";
import type { AgentProfileForRunner } from "./runner/sand-agent-runner.js";
import type {
  AutomationRecord,
  AutomationReview,
  WorkflowRecord,
} from "./runner/tools/sand-state-tool.js";
import type {
  CloudAgentApi,
  CloudAgentToolContext,
  CloudAgentToolDeps,
} from "./cloud-agents/cloud-agent-tool.js";
import {
  SAND_EXTERNAL_READ_TOOL_DESCRIPTION,
  SAND_BOX_READ_TOOL_DESCRIPTION,
  SAND_READ_FORMATTING_OPTIONS,
  liveMcpToolsForTurn,
  type TurnToolsetHostFactoryProvider,
} from "./runner/tools/turn-toolset.js";
import type {
  TurnAwaitToolFactoryInput,
  TurnCloudAgentToolFactoryInput,
  TurnMcpManagementToolFactoryInput,
  TurnMcpMetaToolFactoryInput,
  TurnReadToolFactoryInput,
  TurnWebFetchToolFactoryInput,
  TurnWebSearchToolFactoryInput,
} from "./runner/tools/turn-toolset.js";
import type {
  RemoteResource,
  ResourceAccessor,
} from "../packages/agent-exec/resource-provider.js";
import { subagentExecutorResource } from "../packages/agent-exec/subagent.js";
import { requestContextExecutorResource } from "../packages/agent-exec/request-context.js";
import { subagentRegistryResource } from "../packages/agent/tools/subagent-registry.js";
import { smartModeClassifierExecutorResource } from "../packages/agent-exec/smart-mode-classifier.js";
import { mcpExecutorResource, mcpStateExecutorResource } from "../packages/agent-exec/mcp.js";
import { shellStreamExecutorResource } from "../packages/agent-exec/shell-stream.js";
import { backgroundShellExecutorResource } from "../packages/agent-exec/background-shell.js";
import type { RemoteExecManager } from "../packages/agent-exec/remote.js";
import {
  SAND_BOX_AWAIT_SHELL_TOOL_NAME,
  SAND_BOX_READ_TOOL_NAME,
  SAND_EXTERNAL_AWAIT_SHELL_TOOL_NAME,
  SAND_EXTERNAL_READ_TOOL_NAME,
} from "./sand-activity.js";
import { connectorCardEmissionToMessage } from "./runner/tools/box-help-tool.js";
import { createAgentPromptSession } from "./extensions/inference/extension.js";
import { CONNECTOR_MANIFESTS } from "../shared/channels.js";
import { parseStoredTrigger } from "./automations/automation-trigger.js";
import { listenerPlatformsInTrigger } from "./automations/listener-integrations.js";
import { resolveSharedRoomBoxToolsEnabled } from "./groups/xuser.js";
import { boxAgentWindowIndex, boxIsPreparing, boxSupportsMultiWindow } from "./box/box-capabilities.js";
import { createAutoReviewGate } from "./runner/auto-review-gate.js";
import { reportHostDiagnostic } from "./host-diagnostics.js";
import { errorLogTag } from "../shared/errors.js";
import { boundedConnectorTag } from "../shared/observability/connector-auth-telemetry.js";
import {
  mcpErrorClassOf,
  takeMcpExecErrorClass,
} from "../shared/node/mcp/mcp-diagnostics.js";
import {
  sandAutoReviewApprovalExpiryPolicy,
  SandAutoReviewController,
} from "./runner/sand-auto-review.js";
import {
  createHostBrowserDriverDependencies,
  createHostComputerToolDependencies,
  createHostShellExecutor,
  type HostBrowserBoxOwner,
} from "./runner/host-computer-tool-dependencies.js";
import {
  createRemoteBoxResourceAccessor,
  type RemoteBoxResourceHost,
} from "./runner/remote-box-resources.js";
import { createStreamAttempt } from "./runner/stream-attempt.js";
import {
  createTurnAgentRunStreamInput,
  createTurnAgentStreamStart,
  buildSandSubagentConfigsForRun,
  SAND_MAX_ACTIVE_SUBAGENTS,
  SAND_MAX_SUBAGENT_DEPTH,
  type TurnLocalResourceProjectionInput,
} from "./runner/turn-agent-composition.js";
import {
  createProductionTurnAgentOwner,
  createProductionTurnAgentRunInput,
  type ProductionTurnAgentOwnerInput,
} from "./runner/production-turn-agent-owner.js";
import {
  createProductionTurnRunShellHostInput,
  type TurnLocalToolPermissionEpoch,
} from "./runner/production-turn-run-shell-adapter.js";
import {
  createPromptCollectorGlue,
  type PromptCollectorHost,
} from "./runner/prompt-collector-glue.js";
import type { GeneratedTurnPromptOptions } from "./runner/prompt-collector-glue.js";
import { createRunnerPromptGlue } from "./runner/runner-prompt-glue.js";
import {
  createShellWatchGeneratedStateProjection,
  createShellWatchReadAccessor,
  type ShellTerminalWatchHost,
} from "./runner/shell-terminal-watch.js";
import { DEFAULT_SAND_SYSTEM_PROMPT, buildSandSubagentSystemPrompt } from "./runner/system-prompt.js";
import {
  createSystemPromptAssembly,
  readAgentInstructions,
  type MemoryPromptStore,
  type MemorySnapshotStore,
  type PromptSnapshotStore,
} from "./runner/system-prompt-assembly.js";
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../packages/redaction/privacy-mode.js";
import { tryExtractSandAutoReviewClassifierConversationContext } from "../packages/agent/smart-mode-classifier-context.js";
import {
  buildSandAutomationWriteRiskTarget,
  reviewSandAutomationWrite,
} from "./runner/sand-automation-auto-review.js";
import {
  runSandAutoReviewClassifier,
} from "./runner/sand-auto-review-classifier-run.js";
import { SAND_AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON } from "./runner/sand-automation-auto-review.js";
import { surfaceListenerConnectCards } from "./runner/tools/listener-connect-cards.js";
import {
  buildSandCloudAgentRiskTarget,
  buildSandCloudAgentLifecycleReviewTarget,
  buildSandCloudAgentReviewTarget,
  describeSandCloudAgentReviewImages,
  reviewSandCloudAgentAction,
  reviewSandCloudAgentLifecycleAction,
  SAND_CLOUD_AGENT_CLASSIFIER_ERROR_REASON,
} from "./runner/sand-cloud-agent-auto-review.js";
import type { Context } from "../packages/context/core.js";
import type {
  TurnShellAutoReviewInput,
  TurnToolsetHost,
  TurnToolsetTurnInput,
} from "./runner/tools/turn-toolset.js";
import type { TurnCheckpoint, TurnSettleHost } from "./runner/turn-settle.js";
import { ConversationStateStructure } from "../packages/proto/generated/agent/v1/agent_pb.js";
import type { BlobStore } from "../packages/agent-kv/blob-store.js";
import { toHex } from "../packages/agent-kv/serde.js";
import { isMemorableExchange } from "./runner/sand-memory.js";
import type { TextExecutor } from "./runner/sand-memory.js";
import type { RunnerPromptGlueOwner } from "./runner/runner-prompt-glue.js";
import type { TransferBox } from "./box/box-transfer.js";
import type { CapableBox } from "./box/box-capabilities.js";
import { isNoMonitorComputerUseExecutor } from "./ports/box.js";
import { computerUseExecutorResource } from "../packages/agent-exec/computer-use.js";
import type { UserComputerHandle, FileTransferController } from "./runner/tools/sand-file-transfer-tools.js";
import type { AgentProfilePromptSnapshot } from "./runner/sand-agent-profile-prompt.js";
import type {
  RunningSubagentInfo,
  SubagentManagementController,
} from "./runner/tools/sand-subagent-management-tools.js";
import type {
  SubagentSession,
  SubagentRunOptions,
} from "./runner/subagent-runtime.js";
import type {
  SubagentAdapterArgs,
} from "./runner/agent-adapters.js";
import type { CursorRule } from "../packages/proto/generated/agent/v1/cursor_rules_pb.js";

export const DEFAULT_SAND_MODEL = "gpt-5.5-high-fast";
export const SAND_SUMMARIZATION_MAX_PROMPT_CHARS = 2_800_000;

type DynamicApi = Record<string, any>;

export interface HostRunnerSession {
  readonly id: string;
  readonly dbPath: string;
  readonly agentStore?: DynamicApi;
  readonly memory?: unknown;
  readonly automations?: unknown;
  readonly workflows?: unknown;
  readonly channels?: unknown;
  readonly db?: unknown;
}

export interface HostRunnerHooks {
  readonly transport: {
    onUpdate(
      update: unknown,
      cancelThisRun?: ProductionTurnCancelThisRun,
    ): void;
    lastSentMessageId?(): string | undefined;
    lastReactionApplied?(): boolean;
  };
  /** Exact turn-scoped card emitter; omitted callers remain fail-closed. */
  readonly emitUpdate?: ProductionTurnEmitUpdate;
  readonly onRunLifecycle?: (event: unknown) => void;
  readonly agentProfileProvider?: () => AgentProfileForRunner | null;
  readonly ingestAttachment?: (sourcePath: string) => Promise<string>;
  readonly persistImage?: (...args: any[]) => unknown;
  readonly persistMediaBytes?: (
    filename: string,
    data: Uint8Array,
  ) => Promise<string | null>;
}

export interface HostRunnerOverrides {
  readonly groupMemberTurn?: boolean;
  readonly isSharedRoomTurn?: boolean;
  readonly systemPrompt?: unknown;
  readonly [key: string]: unknown;
}

export interface HostRunnerExtensions {
  api(id: string): DynamicApi;
}

/**
 * The per-turn resource owner is created only after the box has been made
 * ready.  The box owns the remote accessor; this boundary deliberately does
 * not cache it or manufacture a fallback accessor between turns.
 */
export interface ProductionBoxResourceOwner {
  ensureReady(
    context: unknown,
    agentId: string,
  ): Promise<{ readonly remoteAccessor?: unknown }>;
}

export type ProductionResourceAccessor = ResourceAccessor<RemoteExecManager>;

export function createPerTurnResourceAccessor(
  owner: ProductionBoxResourceOwner,
  agentId: string,
): (context: unknown) => Promise<ProductionResourceAccessor> {
  return async (context: unknown): Promise<ProductionResourceAccessor> => {
    const connection = await owner.ensureReady(context, agentId);
    const accessor = connection?.remoteAccessor;
    if (
      typeof accessor !== "object"
      || accessor == null
      || typeof (accessor as { readonly get?: unknown }).get !== "function"
    ) {
      throw new TypeError("production Agent resource accessor is not bound");
    }
    return accessor as ProductionResourceAccessor;
  };
}

export interface ProductionSessionBoundRunner {
  readonly subagents: {
    readonly sessions: Map<string, SubagentSession>;
    isRunning(agentId: string): boolean;
    dispatchBackgroundSubagent(input: Parameters<
      TurnLocalResourceProjectionInput["subagentDispatcher"]["dispatch"]
    >[0]): void;
  };
  readonly computerUse: {
    allocateWindow(agentId: string): unknown | null;
    freeWindow(agentId: string): void;
  } | undefined;
  run(prompt: string, options?: SubagentRunOptions): Promise<unknown>;
  interrupt(reason: string): unknown;
  getResolvedOutline(): Promise<readonly unknown[]>;
  getObservedToolCallCount(): number;
  getActivitySnapshot(): readonly string[];
  getTranscriptPath(): string | null;
  setAgentStore(agentStore: unknown, agentProfileProvider?: unknown): void;
  setMemoryStore(memoryStore: unknown): void;
  setUserMemory(userMemory: unknown): void;
  setProjectMemory(projectMemory: unknown): void;
  setMemorySnapshotStore(memorySnapshots: unknown): void;
  setProfilePromptSnapshotStore(profilePromptSnapshots: unknown): void;
  setEpisodeProgress(episodeProgress: unknown): void;
  setAutomationStore(automationStore: unknown): void;
  setWorkflowStore(workflowStore: unknown): void;
  setChannelStore(channelStore: unknown): void;
  setMcp(mcp: unknown): void;
  setMcpManagement(mcpManagement: unknown): void;
  setAttachmentIngestor(ingest: unknown): void;
  setImagePersister(persistImage: unknown): void;
  setMediaBytesPersister(persistMediaBytes: unknown): void;
}

export interface HostRunnerCompositionDependencies<Runner extends ProductionSessionBoundRunner = ProductionSessionBoundRunner> {
  readonly extensions: HostRunnerExtensions;
  readonly ctx: unknown;
  emitGatewayEvent(event: unknown): void;
  buildRunner(options: Record<string, unknown>): Runner;
  readonly createRunStep?: CreateProductionRunnerRunStep;
  createRequestContext?(options: {
    transcriptsDir: string;
    getUserTimeZone(): unknown;
    resolveTeamRules(): Promise<unknown>;
    getUserFullName(): Promise<unknown>;
  }): unknown;
  createTranscriptMirror?(options: {
    transcriptsDir: string;
    session: HostRunnerSession;
    pool: () => TranscriptMirrorOffloadPool;
    reportOutcome(report: unknown): void;
    isJournalEnabled(): Promise<boolean>;
  }): unknown;
  decorateActionAuditor?(
    actionAuditor: unknown,
    callbacks: {
      onBotBlock(hit: any, record: any): void;
      onSiteVisit(visit: any, record: any): void;
    }
  ): unknown;
  readonly mirrorPoolFactory?: () => TranscriptMirrorOffloadPool;
}

export interface RecoveredHostRunnerComposition<Runner extends ProductionSessionBoundRunner> {
  createRunner(session: HostRunnerSession, hooks: HostRunnerHooks): Runner;
  createGroupMemberRunner(
    session: HostRunnerSession,
    hooks: HostRunnerHooks,
    overrides: HostRunnerOverrides
  ): Runner;
  canAskLocalToolPermission(agentId: string): boolean;
  forgetLocalToolPermission(agentId: string): void;
  dispose(): Promise<void>;
}

function method(api: DynamicApi | undefined, name: string): ((...args: any[]) => any) | undefined {
  if (api == null) return undefined;
  const candidate = api[name];
  return typeof candidate === "function" ? candidate.bind(api) : undefined;
}

function asSandAutoReviewController(value: unknown): SandAutoReviewController | undefined {
  return value instanceof SandAutoReviewController ? value : undefined;
}

function asActionAuditor(
  value: unknown,
): NonNullable<ProductionTurnAutoReviewHostProjection["actionAuditor"]> | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const record = (value as Record<string, unknown>).record;
  if (typeof record !== "function") return undefined;
  return { record: entry => record.call(value, entry) };
}

/**
 * The checkpoint owner every settle host writes through. It is the narrow
 * slice of `AgentStore2` that `turn-settle.ts` actually calls, so a scope can
 * supply the agent's own store, a subagent's own store, or nothing at all.
 */
export interface ProductionCheckpointStore {
  handleCheckpoint(context: unknown, checkpoint: unknown): Promise<void>;
  getMetadata(key: string): string | undefined;
  getBlobStore?(): BlobStore<unknown>;
}

const SUBAGENT_CONVERSATION_ROOT_PREFIX = "sand-subagent-conversation-root-v1__";

/**
 * The durable root slot one subagent's own conversation occupies.
 *
 * It is a pure function of the subagent id, exactly like the agent's own
 * `SAND_CONVERSATION_ROOT_SLOT_ID`: no metadata row and no file name has to
 * agree on where a subagent's checkpoint lives, so a cold process finds it again
 * by recomputing the same bytes. Deriving it from the id is also what keeps two
 * subagents of one agent apart — a shared fixed slot would let the second
 * subagent overwrite the first one's history, which is the same class of defect
 * as one subagent writing into its parent's journal key.
 */
export function subagentConversationRootBlobId(agentId: string): Uint8Array {
  return new TextEncoder().encode(`${SUBAGENT_CONVERSATION_ROOT_PREFIX}${agentId}`);
}

/**
 * A subagent's own durable conversation, kept out of its parent's store.
 *
 * A subagent used to settle through the parent's `AgentStore2`: its checkpoint
 * replaced the parent's whole `ConversationStateStructure` and its
 * `latestRootBlobId`, so the parent's durable root was whatever the child last
 * wrote. This store gives the child its own root slot in the agent's blob store
 * and never touches the parent's structure, metadata or root id. The parent's
 * `subagentStates` entry (written by the Task tool through
 * `persistSubagentState`) keeps describing the subagent for `resume`.
 */
export class SubagentConversationStore {
  #structure = new ConversationStateStructure();
  readonly #blobStore: BlobStore<unknown>;
  readonly #rootBlobId: Uint8Array;
  readonly #ready: Promise<void>;

  constructor(readonly agentId: string, blobStore: BlobStore<unknown>) {
    this.#blobStore = blobStore;
    this.#rootBlobId = subagentConversationRootBlobId(agentId);
    this.#ready = this.#load();
  }

  /** Resolves once the durable root has been read, so a cold subagent resumes
   *  its own turns instead of racing its first checkpoint against them. */
  ready(): Promise<void> {
    return this.#ready;
  }

  async #load(): Promise<void> {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.#blobStore.getBlob(undefined, this.#rootBlobId);
    } catch {
      return;
    }
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) return;
    try {
      this.#structure = ConversationStateStructure.fromBinary(bytes);
    } catch {
      this.#structure = new ConversationStateStructure();
    }
  }

  getId(): string {
    return this.agentId;
  }

  getBlobStore(): BlobStore<unknown> {
    return this.#blobStore;
  }

  getConversationStateStructure(): ConversationStateStructure {
    return this.#structure;
  }

  async handleCheckpoint(
    _context: unknown,
    checkpoint: ConversationStateStructure,
  ): Promise<void> {
    this.#structure = checkpoint;
    await this.#blobStore.setBlob(
      undefined,
      this.#rootBlobId,
      checkpoint.toBinary(),
    );
  }

  getMetadata(key: string): string | undefined {
    return key === "latestRootBlobId" ? toHex(this.#rootBlobId) : undefined;
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

/** The runner surface a settle host reads and writes for ONE agent. */
export interface ProductionTurnSettleRunner {
  readonly currentRunGeneration?: number;
  getBlobStore?(): unknown;
  getLatestPromptMessages?(): readonly unknown[];
  setAgentConversationStateStructure?(structure: TurnCheckpoint): void;
}

/**
 * Everything a settle host must be told about the agent whose turn it settles.
 *
 * The three fields that used to be closed over `session.id` — the transcript id,
 * the runner and the checkpoint store — are the whole defect. A subagent created
 * by `createSubagentRunner` settles through the parent's scope, so its
 * checkpoints were appended to the parent's journal key: the parent then wrote
 * its own next checkpoint, whose turn list no longer contained the subagent's
 * turn, and `transcript-occurrence-deriver.ts` refused it with "durable
 * conversation turns moved backwards". A subagent's scope passes the subagent's
 * own agent id, its own runner and its own store, so the two never share a key.
 */
export interface ProductionTurnSettleScope {
  /** The agent id this scope owns. It is the transcript id and the journal key. */
  readonly agentId: string;
  readonly isSubagentRunner: boolean;
  /** The runner of THIS agent. A subagent must pass its own, never the parent's. */
  readonly runner: ProductionTurnSettleRunner | undefined;
  /** The durable checkpoint store of THIS agent, and of no other. */
  readonly agentStore: ProductionCheckpointStore;
}

/**
 * The identity a Task subagent settles under.
 *
 * This is the seam the whole fix turns on, and it is the ONLY place a subagent's
 * journal key is chosen. Reading the parent out of here — `agentId: parentId`, or
 * the parent's `agentStore` — is what made every `Task` dispatch kill its own
 * parent turn with "durable conversation turns moved backwards". The subagent id
 * and the parent's id are both in hand here, which is exactly why the choice
 * cannot be an accident.
 */
export function resolveSubagentSettleIdentity(
  subagentId: string,
  parentAgentStore: ProductionCheckpointStore,
): {
  readonly agentId: string;
  readonly isSubagentRunner: true;
  readonly conversationStore: SubagentConversationStore;
  /** Resolves when the subagent's durable root has been read. */
  readonly ready: Promise<void>;
} {
  const conversationStore = new SubagentConversationStore(
    subagentId,
    getAgentBlobStore(
      parentAgentStore as unknown as { getBlobStore(): BlobStore<unknown> },
    ),
  );
  return {
    agentId: subagentId,
    isSubagentRunner: true,
    conversationStore,
    ready: conversationStore.ready(),
  };
}

export interface ProductionTurnSettleHostExtras {
  readonly transcriptMirror?: TurnSettleHost["transcriptMirror"];
  readonly persistAnnouncedAgentProfile?: TurnSettleHost["persistAnnouncedAgentProfile"];
  /**
   * A shared-room turn settles with the subagent flag on, because it has no
   * canonical transcript of its own. Kept as an explicit input so the flag is
   * never inferred from a captured constant again.
   */
  readonly settlesAsSubagent?: boolean;
}

/**
 * Builds the settle host for one agent scope.
 *
 * Every identity here comes from `scope`, never from a captured parent session:
 * `getTranscriptId` is the journal key, `getBlobStore` is the store the deriver
 * resolves that key's blobs through, and `agentStore` is what
 * `turn-settle.ts` persists into.
 */
export function createProductionTurnSettleHostForScope(
  scope: ProductionTurnSettleScope,
  extras: ProductionTurnSettleHostExtras = {},
): TurnSettleHost {
  const store = scope.agentStore;
  if (
    store == null
    || typeof store.handleCheckpoint !== "function"
    || typeof store.getMetadata !== "function"
  ) {
    throw new TypeError("production Agent checkpoint store is not bound");
  }
  const runner = scope.runner;
  const generation = runner?.currentRunGeneration;
  const fallbackBlobStore = getAgentBlobStore(
    store as unknown as { getBlobStore(): BlobStore<unknown> },
  );
  return {
    isSubagentRunner: scope.isSubagentRunner || extras.settlesAsSubagent === true,
    ...(extras.transcriptMirror === undefined
      ? {}
      : { transcriptMirror: extras.transcriptMirror }),
    getTranscriptId: () => scope.agentId,
    getBlobStore: () => runner?.getBlobStore?.() ?? fallbackBlobStore,
    agentStore: () => ({
      handleCheckpoint: (context: unknown, checkpoint: unknown) =>
        store.handleCheckpoint(context, checkpoint),
      getMetadata: (key: string) => store.getMetadata(key),
    }),
    setLocalState: checkpoint => {
      if (typeof runner?.setAgentConversationStateStructure !== "function") {
        throw new TypeError("production Agent local checkpoint store is not bound");
      }
      runner.setAgentConversationStateStructure(checkpoint);
    },
    ownsRunner: () => true,
    isRunSuperseded: () =>
      generation !== undefined
      && runner?.currentRunGeneration !== undefined
      && runner.currentRunGeneration !== generation,
    latestPromptMessages: () => runner?.getLatestPromptMessages?.() ?? [],
    persistAnnouncedAgentProfile: (snapshots, snapshot, identity) => {
      extras.persistAnnouncedAgentProfile?.(snapshots, snapshot, identity);
    },
  };
}

function asLocalToolPermissionProjection(
  value: unknown,
): NonNullable<ProductionTurnAutoReviewHostProjection["localToolPermission"]> | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const awaitDesktopStandingDecision = candidate.awaitDesktopStandingDecision;
  const completeScope = candidate.completeScope;
  if (
    typeof awaitDesktopStandingDecision !== "function"
    || typeof completeScope !== "function"
  ) return undefined;
  return {
    awaitDesktopStandingDecision: args =>
      awaitDesktopStandingDecision.call(value, args),
    completeScope: scope => completeScope.call(value, scope),
  };
}

/**
 * The turn's view of the SAME controller `asLocalToolPermissionProjection`
 * narrows — the two methods one turn needs to open a direction and to read its
 * number.
 *
 * It is a separate projection on purpose. The toolset one keeps only
 * `{awaitDesktopStandingDecision, completeScope}` and drops both of these, so
 * handing its result to a turn shell leaves `resolveTurnDirectionEpoch` with
 * nothing to read: the context never receives an epoch, the shell's
 * `beginLocalToolPermissionTurn` hook has no controller to call, and every turn
 * runs under 0 for the life of the process. Both methods are re-bound to the
 * original object, so the controller keeps its own `directionEpochs` map.
 */
function asTurnLocalToolPermissionEpoch(
  value: unknown,
): TurnLocalToolPermissionEpoch | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const beginTurn = candidate.beginTurn;
  const directionEpoch = candidate.directionEpoch;
  if (typeof beginTurn !== "function" || typeof directionEpoch !== "function") {
    return undefined;
  }
  return {
    beginTurn: agentId => beginTurn.call(value, agentId),
    directionEpoch: agentId => directionEpoch.call(value, agentId),
  };
}

type ProductionClassifierStateHandler = Parameters<
  typeof tryExtractSandAutoReviewClassifierConversationContext
>[1];

function asProductionClassifierStateHandler(
  value: unknown,
): ProductionClassifierStateHandler | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const turns = candidate.turns;
  const rootPromptBuilder = candidate.rootPromptBuilder;
  if (
    !Array.isArray(turns)
    || typeof rootPromptBuilder !== "object"
    || rootPromptBuilder == null
    || typeof (rootPromptBuilder as Record<string, unknown>).getState !== "function"
  ) return undefined;
  return value as ProductionClassifierStateHandler;
}

export async function extractProductionTurnAutoReviewConversationContext(
  context: Context,
  stateHandler: unknown,
) {
  const candidate = asProductionClassifierStateHandler(stateHandler);
  if (candidate === undefined) return [];
  return [
    ...await tryExtractSandAutoReviewClassifierConversationContext(
      context,
      candidate,
    ),
  ];
}

function isAgentContext(value: unknown): value is Context {
  return typeof value === "object" && value != null
    && typeof (value as { with?: unknown }).with === "function"
    && typeof (value as { get?: unknown }).get === "function"
    && typeof (value as { withCancel?: unknown }).withCancel === "function";
}

interface PromptRequestContext {
  resolve(): {
    readonly osVersion?: string;
    readonly shell?: string;
    readonly timeZone?: string;
    readonly transcriptsFolder?: string;
    readonly userFullName?: string;
  };
  resolveRules(): Promise<CursorRule[] | undefined>;
}

function asTransferBox(value: unknown): TransferBox | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const downloadFile = candidate.downloadFile;
  const uploadFile = candidate.uploadFile;
  if (typeof downloadFile !== "function" || typeof uploadFile !== "function") return undefined;
  return {
    downloadFile: (context, agentId, path) =>
      downloadFile.call(value, context, agentId, path),
    uploadFile: (context, agentId, path, data) =>
      uploadFile.call(value, context, agentId, path, data),
  };
}

function asCapableTransferBox(value: unknown): TransferBox & CapableBox | undefined {
  const transfer = asTransferBox(value);
  if (transfer === undefined) return undefined;
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const capable: TransferBox & CapableBox = transfer;
  const getTerminalsFolder = candidate.getTerminalsFolder;
  if (typeof getTerminalsFolder === "function") {
    capable.getTerminalsFolder = () => getTerminalsFolder.call(value);
  }
  const isAvailable = candidate.isAvailable;
  if (typeof isAvailable === "function") {
    capable.isAvailable = () => isAvailable.call(value);
  }
  const isPreparing = candidate.isPreparing;
  if (typeof isPreparing === "function") {
    capable.isPreparing = (agentId) => isPreparing.call(value, agentId);
  }
  const getAgentWindowIndex = candidate.getAgentWindowIndex;
  if (typeof getAgentWindowIndex === "function") {
    capable.getAgentWindowIndex = agentId => getAgentWindowIndex.call(value, agentId);
  }
  return capable;
}

type RemoteBoxResourceOwner = RemoteBoxResourceHost["remoteBox"];

function asRemoteBoxResourceOwner(value: unknown): RemoteBoxResourceOwner | undefined {
  const capable = asCapableTransferBox(value);
  if (capable === undefined || typeof value !== "object" || value == null) return undefined;
  const ensureReady = (value as Record<string, unknown>).ensureReady;
  if (typeof ensureReady !== "function") return undefined;
  return {
    ...capable,
    ensureReady: (context, agentId) => ensureReady.call(value, context, agentId),
  };
}

function asProductionResourceAccessor(
  registry: ReturnType<typeof createRemoteBoxResourceAccessor>,
): ProductionResourceAccessor {
  return {
    get<Implementation>(
      resource: RemoteResource<Implementation, RemoteExecManager>,
    ): Implementation {
      const value = registry.get({
        symbol: resource.symbol,
        remoteImplementation: resource.remoteImplementation,
        registerControlledImplementation: () => {},
      });
      if (value === undefined) {
        const knownResources: ReadonlyArray<readonly [symbol, string]> = [
          [subagentExecutorResource.symbol, "subagentExecutorResource"],
          [requestContextExecutorResource.symbol, "requestContextExecutorResource"],
          [subagentRegistryResource.symbol, "subagentRegistryResource"],
          [smartModeClassifierExecutorResource.symbol, "smartModeClassifierExecutorResource"],
          [mcpExecutorResource.symbol, "mcpExecutorResource"],
          [mcpStateExecutorResource.symbol, "mcpStateExecutorResource"],
          [shellStreamExecutorResource.symbol, "shellStreamExecutorResource"],
          [backgroundShellExecutorResource.symbol, "backgroundShellExecutorResource"],
        ];
        const resourceName = knownResources.find(([known]) => known === resource.symbol)?.[1]
          ?? "unknownResource";
        const implementationSource = Function.prototype.toString.call(
          resource.remoteImplementation,
        );
        const requestedResourceProvenance = {
          resourceName,
          symbolDescription: resource.symbol.description ?? null,
          symbolRegistryKey: Symbol.keyFor(resource.symbol) ?? null,
          remoteImplementationName: resource.remoteImplementation.name || null,
          wireNames: Array.from(
            implementationSource.matchAll(/["']([A-Za-z][A-Za-z0-9]*)["']/g),
            match => match[1],
          ),
        } as const;
        const error = new TypeError(
          `production remote resource is not registered: ${JSON.stringify(requestedResourceProvenance)}`,
        );
        Object.defineProperties(error, {
          requestedResourceSymbol: { value: resource.symbol, enumerable: true },
          requestedResourceProvenance: {
            value: requestedResourceProvenance,
            enumerable: true,
          },
        });
        console.error("[sand-host] production resource lookup failed", error);
        throw error;
      }
      return value;
    },
  };
}

function asUserComputer(value: unknown): UserComputerHandle | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const box = asTransferBox(candidate.box);
  if (
    typeof candidate.id !== "string"
    || typeof candidate.label !== "string"
    || typeof candidate.connected !== "boolean"
    || box === undefined
  ) return undefined;
  return {
    id: candidate.id,
    label: candidate.label,
    connected: candidate.connected,
    box,
  };
}

function asPromptUserComputers(value: unknown): RunnerPromptGlueOwner["userComputers"] | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const resolve = candidate.resolve;
  const list = candidate.list;
  if (typeof resolve !== "function" || typeof list !== "function") return undefined;
  return {
    resolve: (computerId) => asUserComputer(resolve.call(value, computerId)),
    list: () => {
      const listed = list.call(value);
      if (!Array.isArray(listed)) return [];
      return listed.flatMap(computer => {
        const resolved = asUserComputer(computer);
        return resolved === undefined ? [] : [resolved];
      });
    },
  };
}

/**
 * Adapts the local-exec bridge's computer registry to the `FileTransferController`
 * shape the shipped CopyToBox/CopyFromBox tools consume.
 *
 * The bridge answers two different shapes: `list()` rows carry
 * `{ id, label, connected }`, and `resolve()` answers `{ id, label, box }` without
 * the liveness flag. The tools need one row with both, so liveness is read from
 * the same `list()` the bridge itself derives it from, and the box comes from
 * `resolve()`. Neither half is synthesized here.
 */
function asFileTransferUserComputers(
  value: unknown,
): FileTransferController["userComputers"] | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const resolve = candidate.resolve;
  const list = candidate.list;
  if (typeof resolve !== "function" || typeof list !== "function") return undefined;
  const listed = (): readonly { id: string; connected: boolean }[] => {
    const rows = list.call(value);
    if (!Array.isArray(rows)) return [];
    return rows.flatMap(row => {
      if (typeof row !== "object" || row == null) return [];
      const id = Reflect.get(row, "id");
      const connected = Reflect.get(row, "connected");
      return typeof id === "string" && typeof connected === "boolean"
        ? [{ id, connected }]
        : [];
    });
  };
  const handle = (id: string): UserComputerHandle | undefined => {
    const live = listed().find(computer => computer.id === id);
    if (live === undefined) return undefined;
    return asUserComputer(resolve.call(value, id));
  };
  return {
    resolve: (computerId) => {
      if (computerId != null) return handle(computerId);
      const active = listed().find(computer => computer.connected);
      return active === undefined ? undefined : handle(active.id);
    },
    list: () => listed().flatMap(computer => {
      const resolved = handle(computer.id);
      return resolved === undefined ? [] : [{ ...resolved, connected: computer.connected }];
    }),
  };
}

function isGeneratedSelectedVideo(
  value: unknown,
): value is NonNullable<GeneratedTurnPromptOptions["selectedVideos"]>[number] {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as Record<string, unknown>;
  const dataOrBlobId = candidate.dataOrBlobId;
  return typeof candidate.uuid === "string"
    && typeof candidate.path === "string"
    && typeof candidate.mimeType === "string"
    && typeof candidate.filename === "string"
    && typeof candidate.materializeToFilesystem === "boolean"
    && typeof dataOrBlobId === "object"
    && dataOrBlobId != null
    && typeof (dataOrBlobId as Record<string, unknown>).case === "string";
}

function isAgentProfilePromptSnapshot(value: unknown): value is AgentProfilePromptSnapshot {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as Record<string, unknown>;
  const systemIdentity = candidate.systemIdentity;
  const announcedIdentity = candidate.announcedIdentity;
  const identity = (entry: unknown): boolean =>
    typeof entry === "object"
    && entry != null
    && typeof (entry as Record<string, unknown>).name === "string"
    && typeof (entry as Record<string, unknown>).description === "string";
  return candidate.version === 1
    && typeof candidate.profileSection === "string"
    && identity(systemIdentity)
    && identity(announcedIdentity)
    && typeof candidate.compactionEpoch === "number";
}

function asPromptSnapshotStore(value: unknown): PromptSnapshotStore | undefined {
  if (typeof value !== "object" || value == null) return undefined;
  const candidate = value as Record<string, unknown>;
  const getSnapshot = candidate.getAgentProfilePromptSnapshot;
  const setSnapshot = candidate.setAgentProfilePromptSnapshot;
  if (typeof getSnapshot !== "function" || typeof setSnapshot !== "function") return undefined;
  return {
    getAgentProfilePromptSnapshot: () => {
      const snapshot = getSnapshot.call(value);
      return isAgentProfilePromptSnapshot(snapshot) ? snapshot : undefined;
    },
    setAgentProfilePromptSnapshot: snapshot => {
      setSnapshot.call(value, snapshot);
    },
  };
}

function createTypedInferenceOwner(
  value: DynamicApi,
): ProductionTurnAgentOwnerInput["inference"] {
  const createSession = method(value, "createSession");
  const resolvePrivacyMode = method(value, "resolvePrivacyMode");
  if (createSession === undefined || resolvePrivacyMode === undefined) {
    throw new TypeError("production inference session/privacy owner is not bound");
  }
  const createSummarizationSession = method(value, "createSummarizationSession");
  return {
    createSession: (onRequestId, options) => createSession(onRequestId, options),
    resolvePrivacyMode: async (): Promise<PrivacyModeValue> => {
      const resolved = await resolvePrivacyMode();
      if (
        resolved === PrivacyMode.UNSPECIFIED
        || resolved === PrivacyMode.NO_STORAGE
        || resolved === PrivacyMode.NO_TRAINING
        || resolved === PrivacyMode.USAGE_DATA_TRAINING_ALLOWED
        || resolved === PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED
      ) return resolved;
      throw new TypeError("production inference returned an invalid privacy mode");
    },
    ...(createSummarizationSession === undefined
      ? {}
      : { createSummarizationSession: (onRequestId: (requestId: string) => void, options?: Readonly<Record<string, unknown>>) => createSummarizationSession(onRequestId, options) }),
  };
}

function createTextExecutor(executor: {
  appendMessages(...args: any[]): void;
  clearMessages(): void;
  getMessages(): readonly unknown[];
  getState(): unknown;
  stream(...args: any[]): unknown;
}): TextExecutor {
  return {
    appendMessages: messages => executor.appendMessages(messages),
    clearMessages: () => executor.clearMessages(),
    getMessages: () => executor.getMessages(),
    getState: () => executor.getState(),
    stream: (context, first, second, options) => {
      const result = executor.stream(context, first, second, options);
      if (typeof result !== "object" || result == null) {
        throw new TypeError("production prompt executor returned no stream");
      }
      const fullStream = (result as Record<string, unknown>).fullStream;
      if (
        typeof fullStream !== "object"
        || fullStream == null
        || typeof (fullStream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function"
      ) throw new TypeError("production prompt executor returned an invalid stream");
      return { fullStream: fullStream as AsyncIterable<{ readonly type: string; readonly textDelta?: string; readonly error?: unknown }> };
    },
  };
}

function toGeneratedTurnPromptOptions(
  options: {
    readonly selectedImages?: readonly unknown[];
    readonly selectedVideos?: readonly unknown[];
    readonly attachedFilePaths?: readonly string[];
    readonly attachedFileSizes?: ReadonlyMap<string, number>;
    readonly richText?: string;
    readonly replyContext?: unknown;
    readonly messageId?: string;
    readonly automationWake?: { readonly id: string };
    readonly isSilenceAllowed?: boolean;
    readonly appendReplyReminder?: boolean;
    readonly hidden?: boolean;
    readonly recentUserMessages?: readonly { readonly id: string; readonly text: string }[];
    readonly userReactionNotices?: readonly string[];
  },
): GeneratedTurnPromptOptions {
  const selectedImages = options.selectedImages?.flatMap(image => {
    if (typeof image !== "object" || image == null) return [];
    const record = image as Record<string, unknown>;
    const data = record.data;
    if (!(data instanceof Uint8Array)) return [];
    return [{
      data,
      ...(typeof record.path === "string" ? { path: record.path } : {}),
      ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
    }];
  });
  const selectedVideos = options.selectedVideos?.filter(isGeneratedSelectedVideo);
  return {
    ...(selectedImages === undefined ? {} : { selectedImages }),
    ...(selectedVideos === undefined ? {} : { selectedVideos }),
    ...(options.attachedFilePaths === undefined ? {} : { attachedFilePaths: options.attachedFilePaths }),
    ...(options.attachedFileSizes === undefined ? {} : { attachedFileSizes: options.attachedFileSizes }),
    ...(options.richText === undefined ? {} : { richText: options.richText }),
    ...(options.replyContext === undefined ? {} : { replyContext: options.replyContext }),
    ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
    ...(options.automationWake === undefined ? {} : { automationWake: options.automationWake }),
    ...(options.isSilenceAllowed === undefined ? {} : { isSilenceAllowed: options.isSilenceAllowed }),
    ...(options.appendReplyReminder === undefined ? {} : { appendReplyReminder: options.appendReplyReminder }),
    ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
    ...(options.recentUserMessages === undefined ? {} : { recentUserMessages: options.recentUserMessages }),
    // This is a whitelist, not a pass-through: an option missing here never
    // reaches `assembleGeneratedTurnAction` and is dropped without a trace.
    ...(options.userReactionNotices === undefined ? {} : { userReactionNotices: options.userReactionNotices }),
  };
}

function isPromptRequestContext(value: unknown): value is PromptRequestContext {
  return typeof value === "object" && value != null
    && typeof (value as { resolve?: unknown }).resolve === "function"
    && typeof (value as { resolveRules?: unknown }).resolveRules === "function";
}

function resolveRequestContextEnvironment(
  requestContext: unknown,
): {
  readonly timeZone?: string;
  readonly projectFolder?: string;
  readonly osVersion?: string;
} {
  if (
    typeof requestContext !== "object"
    || requestContext == null
    || typeof (requestContext as { readonly resolve?: unknown }).resolve !== "function"
  ) return {};
  const resolved = (requestContext as { resolve(): unknown }).resolve();
  if (typeof resolved !== "object" || resolved == null) return {};
  const candidate = resolved as Record<string, unknown>;
  const environment = typeof candidate.env === "object" && candidate.env != null
    ? candidate.env as Record<string, unknown>
    : candidate;
  return {
    ...(typeof (candidate.timeZone ?? environment.timeZone) === "string"
      ? { timeZone: (candidate.timeZone ?? environment.timeZone) as string }
      : {}),
    ...(typeof environment.projectFolder === "string"
      ? { projectFolder: environment.projectFolder }
      : {}),
    ...(typeof (candidate.osVersion ?? environment.osVersion) === "string"
      ? { osVersion: (candidate.osVersion ?? environment.osVersion) as string }
      : {}),
  };
}

function isCloudAgentApi(api: DynamicApi): api is CloudAgentApi {
  return ["launch", "list", "listModels", "get", "reply", "rename", "cancel", "setArchived", "delete", "listArtifacts", "getTranscriptDump"]
    .every(name => typeof api[name] === "function");
}

interface RunnerSubagentOwner {
  listRunningSubagents(): readonly RunningSubagentInfo[];
  getRunningSubagent(id: string): RunningSubagentInfo | null;
  steerSubagent(id: string, message: string): "steered" | "not-running" | string;
  abortSubagent(id: string): "aborted" | "not-running" | string;
}

interface RunnerCloudWatchOwner {
  isCloudWatchReady?(): boolean;
  watchCloudAgent(
    id: string,
    options?: { readonly quietOrigin?: string; readonly afterFollowup?: boolean },
  ): void;
}

function isRunnerSubagentOwner(value: unknown): value is RunnerSubagentOwner {
  if (typeof value !== "object" || value == null) return false;
  const candidate = value as Record<string, unknown>;
  return [
    "listRunningSubagents",
    "getRunningSubagent",
    "steerSubagent",
    "abortSubagent",
  ].every(name => typeof candidate[name] === "function");
}

function createRunnerSubagentManagement(
  value: unknown,
): SubagentManagementController<unknown> | undefined {
  if (!isRunnerSubagentOwner(value)) return undefined;
  return {
    listRunningSubagents: () => value.listRunningSubagents(),
    getRunningSubagent: id => value.getRunningSubagent(id) ?? undefined,
    steerSubagent: (id, message) => value.steerSubagent(id, message),
    abortSubagent: id => value.abortSubagent(id),
  };
}

function createRunnerCloudWatch(
  value: unknown,
): CloudAgentToolDeps["watch"] | undefined {
  if (
    typeof value !== "object"
    || value == null
    || typeof (value as Record<string, unknown>).watchCloudAgent !== "function"
  ) return undefined;
  const owner = value as RunnerCloudWatchOwner;
  if (
    typeof owner.isCloudWatchReady === "function"
    && owner.isCloudWatchReady() !== true
  ) return undefined;
  return (id, options) => {
    const quietOrigin = typeof options.quietOrigin === "string"
      ? options.quietOrigin
      : undefined;
    owner.watchCloudAgent(id, {
      ...(quietOrigin === undefined ? {} : { quietOrigin }),
      ...(options.afterFollowup === undefined
        ? {}
        : { afterFollowup: options.afterFollowup }),
    });
  };
}

function requestIdForwarder(hooks: HostRunnerHooks, source: string) {
  return (requestId: string) => {
    hooks.transport.onUpdate({
      type: "request-id",
      requestId,
      source
    });
  };
}

/**
 * Composes each turn runner from extension-owned ports. The composition keeps
 * group-member turns intentionally narrower: they do not receive the private
 * transcript mirror, memory stores, image persistence, or local permission
 * approval surface.
 */
export function createHostRunnerComposition<Runner extends ProductionSessionBoundRunner>(
  deps: HostRunnerCompositionDependencies<Runner>
): RecoveredHostRunnerComposition<Runner> {
  const { extensions, ctx } = deps;
  const auth = extensions.api("auth");
  const localToolPermission = extensions.api("local-tool-permission");
  const localToolPermissionSurfaces = new Map<string, () => void>();
  const ownedRunners = new Set<Runner>();
  let mirrorOffloadPool: TranscriptMirrorOffloadPool | null = null;

  const getMirrorOffloadPool = () => {
    mirrorOffloadPool ??=
      deps.mirrorPoolFactory?.() ?? new TranscriptMirrorOffloadPool();
    return mirrorOffloadPool;
  };

  const resolveAgentDisplayName = (agentId: string): string | null => {
    const transcript = extensions.api("transcript");
    const roster = method(transcript, "listAgentsSync")?.() ?? [];
    return roster.find(
      (agent: any) => agent.id === agentId && agent.isGroup !== true
    )?.name ?? null;
  };

  function bindLocalPermissionSurface(
    session: HostRunnerSession,
    hooks: HostRunnerHooks,
    overrides: HostRunnerOverrides
  ): void {
    localToolPermissionSurfaces.get(session.id)?.();
    localToolPermissionSurfaces.delete(session.id);
    if (overrides.groupMemberTurn === true) return;

    const subscribe = method(localToolPermission, "subscribe");
    if (subscribe == null) return;
    const unsubscribe = subscribe((event: any) => {
      if (event?.request?.agentId !== session.id) return;

      if (event.type === "created") {
        hooks.transport.onUpdate({
          type: "send-message",
          message: {
            type: "local-tool-permission",
            ask: {
              requestId: event.request.id,
              action: event.request.action,
              target: event.request.target,
              status: "pending",
              ...(event.request.description === undefined
                ? {}
                : { description: event.request.description })
            }
          },
          timestampMs: Date.now()
        });
        return;
      }

      hooks.transport.onUpdate({
        type: "local-tool-permission-status",
        requestId: event.request.id,
        status: event.request.status === "pending"
          ? "expired"
          : event.request.status
      });
    });
    localToolPermissionSurfaces.set(session.id, unsubscribe);
  }

  function createRunner(
    session: HostRunnerSession,
    hooks: HostRunnerHooks,
    overrides: HostRunnerOverrides = {}
  ): Runner {
    const isSharedRoomTurn = overrides.isSharedRoomTurn === true;
    const localExec = extensions.api("local-exec");
    const attachments = extensions.api("attachments");
    const memory = extensions.api("memory");
    const transcript = extensions.api("transcript");
    const experiments = extensions.api("experiments");
    const telemetry = extensions.api("telemetry");
    const analytics = telemetry.analytics as DynamicApi | undefined;
    const mcp = extensions.api("mcp");
    const sessionApi = extensions.api("session");
    const settings = extensions.api("settings");
    const cloudAgents = extensions.api("cloud-agents");
    const foreverBox = extensions.api("forever-box");
    const remoteBox = foreverBox.box as DynamicApi;
    /** Tool names of the most recent turn built for this runner; empty at first. */
    const lastTurnToolNames = new Set<string>();
    /**
     * Whether this box actually has a monitor.
     *
     * This used to be the literal `true` in four places, which is how the
     * prompt came to promise a desktop the box cannot show: the reconstructed
     * box installs `noMonitorComputerUseExecutor`
     * (`box/generated-production.ts:225`), an executor whose only method throws
     * `SandBoxNoMonitorAvailableError`. The honest predicate is the one the box
     * itself answers — whether its computer-use executor is that throwing stub.
     *
     * Reading it needs a live connection, so the answer is cached by
     * `probeBoxDesktop` (defined below, next to the accessor it reuses) and
     * stays `false` until a turn has proven otherwise: a desktop section that
     * turns out to be real costs one turn of omission, while promising a
     * desktop that does not exist is the defect being fixed.
     */
    const boxDesktopProbe = { answer: false, started: false };
    const boxHasMonitorDesktop = (): boolean => boxDesktopProbe.answer;
    const transcriptsDir = method(sessionApi, "transcriptsDir")?.() ??
      dirname(dirname(session.dbPath));

    /**
     * Builds the controller the shipped CopyToBox/CopyFromBox tools need, or
     * undefined when either endpoint is missing.
     *
     * `agentBox` is the same box Shell and Read run in. `userComputers` is the
     * same bridge ExternalShell runs on, so a file the model can read with
     * ExternalRead is a file CopyToBox can pull. Both halves must be real
     * ports: the tools copy bytes, and a half-wired controller would fail on
     * the first call rather than at build time, so absence is decided here.
     */
    const createHostFileTransferController = (): FileTransferController | undefined => {
      const agentBox = asCapableTransferBox(remoteBox);
      const userComputers = asFileTransferUserComputers(localExec.userComputers);
      if (agentBox === undefined || userComputers === undefined) return undefined;
      return {
        agentBox,
        userComputers,
        // The local bridge keys every read/write by computer, not by agent, so
        // the conversation id is the honest identity on both ends of a transfer.
        getComputerAgentId: () => session.id,
        getBoxId: () => session.id,
        isBoxPreparing: () => boxIsPreparing(agentBox, session.id),
      };
    };

    const actionAuditor = deps.decorateActionAuditor?.(
      extensions.api("action-audit"),
      {
        onBotBlock(hit, record) {
          method(telemetry.brain ?? {}, "reportBotBlock")?.({
            conversationId: record.agentId,
            family: hit.family,
            confidence: hit.confidence,
            blockedHost: hit.blockedHost,
            blockedUrl: hit.blockedUrl
          });
          method(analytics ?? {}, "trackEvent")?.("sand.bot_block", {
            agent_id: record.agentId,
            family: hit.family,
            confidence: hit.confidence,
            blocked_host: hit.blockedHost,
            blocked_url: hit.blockedUrl
          });
        },
        onSiteVisit(visit, record) {
          method(analytics ?? {}, "trackEvent")?.("sand.site.visited", {
            agent_id: record.agentId,
            host: visit.host
          });
        }
      }
    ) ?? extensions.api("action-audit");

    const autoReview = method(
      extensions.api("auto-review"),
      "bindRunner"
    )?.({
      agentId: session.id,
      approvalsResolvable: overrides.groupMemberTurn !== true,
      onUpdate: (update: unknown) => hooks.transport.onUpdate(update)
    }) ?? {};

    const autoReviewController = asSandAutoReviewController(
      autoReview.autoReviewController,
    );

    const autoReviewGate = (() => {
      if (
        autoReviewController == null
        || autoReview.autoReviewModes == null
        || typeof autoReview.getAutoReviewModes !== "function"
      ) return undefined;
      const dependencies = {
        baseModes: autoReview.autoReviewModes,
        getModes: () => autoReview.getAutoReviewModes(),
        controller: () => autoReviewController,
        resolveBoxId: () => session.id,
        ...(typeof autoReview.getAutoReviewInstructions === "function"
          ? { getInstructions: () => autoReview.getAutoReviewInstructions() }
          : {}),
      };
      return createAutoReviewGate(dependencies);
    })();

    const persistImageForTurn = typeof hooks.persistImage === "function"
      ? async (bytes: Uint8Array, mimeType: string) => {
        const result = await hooks.persistImage?.(bytes, mimeType);
        if (
          typeof result === "object"
          && result != null
          && "fileUrl" in result
          && typeof result.fileUrl === "string"
        ) return { fileUrl: result.fileUrl };
        return undefined;
      }
      : undefined;

    const createTurnToolProjections =
      autoReviewGate == null
        ? undefined
        : (input: ProductionTurnToolInputs): ProductionTurnHostToolProjections => {
          const shell = createHostShellExecutor({
            resourceAccessor: input.resourceAccessor,
            assertNoPendingApproval: autoReviewGate.assertNoPendingApproval,
            auditShellCommand: command => {
              method(actionAuditor as DynamicApi, "record")?.({
                agentId: session.id,
                occurredAtMs: Date.now(),
                action: {
                  kind: "shellCommand",
                  command,
                  shellKind: "foreground",
                  target: "box",
                },
              });
            },
          });
          const userAutoRunInstructions = autoReviewGate.userInstructions();
          const projectionAutoReviewModes = autoReviewGate.currentModes();
          const projection = {
            createComputerToolDependencies: () => createHostComputerToolDependencies({
              resourceAccessor: input.resourceAccessor,
              autoReview: {
                mode: projectionAutoReviewModes.computer,
                agentId: session.id,
                boxIdentity: {
                  boxId: session.id,
                  windowGeneration: `${autoReviewController?.hostGeneration ?? "host"}:${session.id}`,
                },
                ...(autoReviewController === undefined
                  ? {}
                  : { autoReviewController }),
                extractConversationContext:
                  extractProductionTurnAutoReviewConversationContext,
                getApprovalExpiryPolicy: () =>
                  sandAutoReviewApprovalExpiryPolicy("turn"),
                resolveDisplayNumber: async (context: unknown) => {
                  await method(remoteBox, "ensureReady")?.(context, session.id);
                  const windowIndex = boxAgentWindowIndex(remoteBox as any, session.id);
                  return windowIndex ?? (boxSupportsMultiWindow(remoteBox as any) ? undefined : 1);
                },
                ...(userAutoRunInstructions === undefined
                  ? {}
                  : { userAutoRunInstructions }),
              },
              ...(persistImageForTurn === undefined
                ? {}
                : { persistImage: persistImageForTurn }),
              isUnicodeTypingEnabled: () =>
                method(experiments, "isUnicodeTypingEnabled")?.() ?? false,
              onComputerAction: action => {
                deps.emitGatewayEvent({
                  channel: "computer-action",
                  payload: { agentId: session.id, ...action },
                });
              },
            }),
            createScreenshotToolDependencies: () => createHostComputerToolDependencies({
              resourceAccessor: input.resourceAccessor,
              ...(persistImageForTurn === undefined
                ? {}
                : { persistImage: persistImageForTurn }),
              isUnicodeTypingEnabled: () =>
                method(experiments, "isUnicodeTypingEnabled")?.() ?? false,
            }),
            createBrowserDriverDependencies: () => createHostBrowserDriverDependencies({
              resourceAccessor: input.resourceAccessor,
              box: remoteBox as unknown as HostBrowserBoxOwner<unknown>,
              getBoxId: () => session.id,
              getDefaultViewId: () => session.id,
              executeShell: shell,
              autoReview: {
                mode: projectionAutoReviewModes.computer,
                agentId: session.id,
                boxIdentity: {
                  boxId: session.id,
                  windowGeneration: `${autoReviewController?.hostGeneration ?? "host"}:${session.id}`,
                },
                ...(autoReviewController === undefined
                  ? {}
                  : { autoReviewController }),
                extractConversationContext:
                  extractProductionTurnAutoReviewConversationContext,
                getApprovalExpiryPolicy: () =>
                  sandAutoReviewApprovalExpiryPolicy("turn"),
                resolveDisplayNumber: async (context: unknown) => {
                  await method(remoteBox, "ensureReady")?.(context, session.id);
                  const windowIndex = boxAgentWindowIndex(remoteBox as any, session.id);
                  return windowIndex ?? (boxSupportsMultiWindow(remoteBox as any) ? undefined : 1);
                },
                ...(userAutoRunInstructions === undefined
                  ? {}
                  : { userAutoRunInstructions }),
              },
              ...(persistImageForTurn === undefined
                ? {}
                : { getPersistImage: () => persistImageForTurn }),
            }),
            createBoxShellExecutor: () => shell,
          };
          return projection;
        };

    const createTurnWebAndAwaitProjections = (
      input: ProductionTurnToolInputs,
    ): ProductionTurnHostToolProjections => {
      const inference = extensions.api("inference");
      const webSearchService = method(inference, "createWebSearch")?.({
        modelId: process.env.SAND_AGENT_MODEL ?? DEFAULT_SAND_MODEL,
        onRequestId: requestIdForwarder(hooks, "web-search"),
      });
      const webFetchService = method(inference, "createWebFetch")?.({
        onRequestId: requestIdForwarder(hooks, "web-fetch"),
      });
      const contextEnvironment = webSearchService === undefined
        && webFetchService === undefined
        ? {}
        : resolveRequestContextEnvironment(requestContext);
      const conversationStartedDate = webSearchService === undefined
        ? undefined
        : method(
          input.stateHandler as DynamicApi,
          "getOrInitializeConversationStartedDate",
        )?.(contextEnvironment.timeZone);
      const projectFolder = contextEnvironment.projectFolder;
      const osPlatform = contextEnvironment.osVersion?.split(" ")[0];
      const webSearch = webSearchService === undefined
        ? undefined
        : {
            webSearchService,
            promptVersion: "latest",
            ...(typeof conversationStartedDate === "string"
              ? { conversationStartedDate }
              : {}),
            ...(projectFolder === undefined ? {} : { projectFolder }),
            ...(osPlatform === undefined ? {} : { osPlatform }),
            resourceAccessor: input.resourceAccessor,
          };
      const webFetch = webFetchService === undefined
        ? undefined
        : {
            webFetchService,
            promptVersion: "latest",
            ...(projectFolder === undefined ? {} : { projectFolder }),
            ...(osPlatform === undefined ? {} : { osPlatform }),
            resourceAccessor: input.resourceAccessor,
          };
      const getTerminalsFolder = method(remoteBox, "getTerminalsFolder");
      const externalAwait: ProductionTurnExternalAwaitInputs | undefined =
        getTerminalsFolder === undefined
          ? undefined
          : {
              resourceAccessor: input.resourceAccessor,
              options: {
                toolName: SAND_EXTERNAL_AWAIT_SHELL_TOOL_NAME,
                terminalsFolder: () => getTerminalsFolder() ?? "",
                enableSubagentAwaiting: false,
                defaultBlockUntilMs: 30_000,
                enableJobCompletionNotifications: true,
              },
            };
      return {
        ...(webSearch === undefined ? {} : { webSearch }),
        ...(webFetch === undefined ? {} : { webFetch }),
        ...(externalAwait === undefined ? {} : { externalAwait }),
      };
    };

    bindLocalPermissionSurface(session, hooks, overrides);

    let builtRunner: Runner | undefined;
    let transcriptMirrorForTurn: TurnSettleHost["transcriptMirror"] | undefined;

    const requestContext = isSharedRoomTurn
      ? {
          resolve: () => ({}),
          resolveRules: async () => []
        }
      : deps.createRequestContext?.({
          transcriptsDir,
          getUserTimeZone: () => method(settings, "getUserTimeZone")?.(),
          resolveTeamRules: async () =>
            await method(
              extensions.api("managed-setup"),
              "resolveTeamRules"
            )?.(),
          getUserFullName: async () =>
            await method(auth, "getUserFullName")?.()
        });

    const resolveCloudAgentTitle = async (_ctx: unknown, bcId: string) =>
      (await method(cloudAgents, "get")?.(bcId))?.name;
    const awaitCloudAgent = method(cloudAgents, "awaitCompletion");
    const sendToAgent = (
      toAgentId: string,
      text: string,
      images: unknown,
      priority: boolean,
    ) => method(transcript, "sendToAgent")?.(
      session.id,
      toAgentId,
      text,
      images,
      priority,
    );
    const agentManagement = {
      create: async (input: { name: string; description: string }) => {
        const result = await method(
          transcript,
          "createBackgroundAgent"
        )?.({
          name: input.name,
          description: input.description
        }, "user");
        const agent = result.agent;
        return {
          id: agent.id,
          name: agent.name,
          description: agent.description
        };
      },
      update: async (
        id: string,
        patch: { name?: string; description?: string }
      ) => {
        const current = (await method(transcript, "listAgents")?.())
          ?.find((agent: any) => agent.id === id);
        if (current == null || current.isGroup) return null;
        const summary = await method(transcript, "updateAgent")?.(id, {
          name: patch.name ?? current.name,
          description: patch.description ?? current.description
        });
        return summary == null
          ? null
          : {
              id: summary.id,
              name: summary.name,
              description: summary.description
            };
      }
    };
    const agentStateOwner = !isSharedRoomTurn
      ? method(memory, "createAgentState")?.({
          memory: session.memory,
          automations: session.automations,
          workflows: session.workflows,
          channels: session.channels,
          agentDir: dirname(session.dbPath),
          agentId: session.id,
          readBoxFile: (boxPath: string) =>
            method(remoteBox, "downloadFile")?.(ctx, session.id, boxPath)
        })
      : undefined;

    const productionContext = isAgentContext(ctx) ? ctx : undefined;
    const productionRequestContext = isPromptRequestContext(requestContext)
      ? requestContext
      : undefined;
    const readVideoAttachmentBytes = method(attachments, "readVideoBytes");
    const mcpCustomInstructions = method(mcp.mcp, "getCustomInstructions");
    let shellWatchWatermark:
      | { readonly turnCount: number; readonly boundaryRef: Uint8Array; readonly lastUserMessageId?: string; readonly hasUserTurn: boolean }
      | undefined;
    const productionPromptGlue = productionContext === undefined
      || productionRequestContext === undefined
      ? undefined
      : (() => {
        const box = asTransferBox(localExec.box);
        const remoteBoxForPrompt = asCapableTransferBox(remoteBox);
        const userComputers = asPromptUserComputers(localExec.userComputers);
        if (box === undefined || remoteBoxForPrompt === undefined || userComputers === undefined) return undefined;
        const readVideoAttachment = readVideoAttachmentBytes === undefined
          ? undefined
          : async (path: string): Promise<Uint8Array | null> => {
              const value = await readVideoAttachmentBytes(path);
              return value instanceof Uint8Array ? value : null;
            };
        return createRunnerPromptGlue({
          ctx: productionContext,
          box,
          remoteBox: remoteBoxForPrompt,
          userComputers,
          remoteBoxHasDesktop: boxHasMonitorDesktop(),
          isSubagentRunner: false,
          isComputerUseSubagent: false,
          isBrowserUseSubagent: false,
          requestContext: productionRequestContext,
          ...(typeof hooks.agentProfileProvider === "function"
            ? { agentProfileProvider: () => hooks.agentProfileProvider?.() ?? { name: "", description: "" } }
            : {}),
          ...(readVideoAttachment === undefined
            ? {}
            : { readVideoAttachmentBytes: readVideoAttachment }),
          isSpotlightEnabled: () => method(experiments, "isSpotlightEnabled")?.() ?? false,
          uploadAttachmentsIntoBox: async paths =>
            new Map(await method(attachments, "stageIntoBox")?.(session.id, paths) ?? []),
          getRemoteBoxAvailable: () => method(remoteBox, "isAvailable")?.() !== false,
          getConversationId: () => session.id,
          resolveBoxId: () => session.id,
          ...(mcpCustomInstructions === undefined
            ? {}
            : { mcp: { getCustomInstructions: async (_context: Context) => await mcpCustomInstructions() } }),
          mcpConnectedServerNamesForTurn: () => [],
          mcpCustomInstructionsForTurn: () => new Map(),
          isMcpDiscoveryUnavailableForTurn: () => false,
          shellWatchHost: () => {
            const store = session.agentStore;
            if (
              store == null
              || typeof store.getConversationStateStructure !== "function"
              || typeof store.getBlobStore !== "function"
            ) throw new TypeError("production prompt state store is not bound");
            const blobStore = getAgentBlobStore(
              store as Parameters<typeof getAgentBlobStore>[0],
            );
            const generated = createShellWatchGeneratedStateProjection({
              getConversationState: () => store.getConversationStateStructure(),
              getBlobStore: () => blobStore,
            });
            const shellHost: ShellTerminalWatchHost<Context> = {
              ctx: productionContext,
              ...generated,
              getConversationId: () => session.id,
              ensureBoxReady: async (pollContext, agentId) => {
                const connection = await remoteBox.ensureReady(pollContext, agentId);
                return {
                  terminalsFolder: method(remoteBox, "getTerminalsFolder")?.() ?? "",
                  remoteAccessor: createShellWatchReadAccessor(connection.remoteAccessor),
                };
              },
              getConfirmedUserTurnWatermarkCache: () => shellWatchWatermark,
              setConfirmedUserTurnWatermarkCache: cache => {
                shellWatchWatermark = cache;
              },
            };
            return shellHost;
          },
        });
      })();
    const productionSystemPromptAssembly = productionContext === undefined
      || productionRequestContext === undefined
      ? undefined
      : createSystemPromptAssembly({
          basePrompt: typeof overrides.systemPrompt === "string"
            ? overrides.systemPrompt
            : DEFAULT_SAND_SYSTEM_PROMPT,
          isSubagentRunner: false,
          // The exact tool names the live turn carries. buildTurnTools reports
          // them through the per-turn input, and the Agent renders the prompt
          // from the handle it just built, so the prompt describes this turn
          // and not the families the source tree happens to contain.
          isToolAvailable: name => lastTurnToolNames.has(name),
          isSharedRoomRunner: isSharedRoomTurn,
          isSystemPromptOverridden: typeof overrides.systemPrompt === "string",
          agentProfileProvider: () => hooks.agentProfileProvider?.() ?? null,
          // Read from the agent directory on every prompt build. A cached copy
          // would make an edited instruction take effect only after a restart,
          // and the whole point of the field is that the user can write it once
          // and see the next turn obey it.
          agentInstructionProvider: () =>
            readAgentInstructions(dirname(session.dbPath)),
          agentStore: () => {
            const store = session.agentStore;
            return store != null && typeof store.getMetadata === "function"
              ? { getMetadata: (key: string) => String(store.getMetadata(key)) }
              : null;
          },
          compactionEpoch: () => 0,
          // These four were the literal `() => null`, which made the memory
          // section unreachable in every prompt: the agent had a real
          // `session.memory` on `runnerOptions` and could still not recall
          // anything it had learned. The stores already built at
          // `runnerOptions` are the same objects, so the prompt reads exactly
          // what the turn would read.
          memoryStore: () => session.memory as unknown as MemoryPromptStore,
          memorySnapshots: () => session.db as unknown as MemorySnapshotStore,
          userMemory: () => method(memory, "createUserMemory")?.({
            agentId: session.id,
            resolveAgentName: resolveAgentDisplayName,
          }) ?? null,
          projectMemory: () => method(memory, "createProjectMemory")?.({
            agentDir: dirname(session.dbPath),
            agentId: session.id,
            resolveAgentName: resolveAgentDisplayName,
          }) ?? null,
          isBoxScopedSubagent: () => false,
          requestContext: {
            resolve: () => {
              const resolved = productionRequestContext.resolve();
              return {
                timeZone: resolved.timeZone ?? "UTC",
                ...(typeof resolved.userFullName === "string"
                  ? { userFullName: resolved.userFullName }
                  : {}),
              };
            },
          },
          automationStore: () => null,
          workflowStore: () => null,
          channelStore: () => null,
          connectorManifests: CONNECTOR_MANIFESTS,
          sendToAgentImpl: sendToAgent,
          agentManagement,
          agentDirectory: () => [],
          agentGroups: () => [],
          agentsRootDir: () => dirname(dirname(session.dbPath)),
          isSpotlightEnabled: () => method(experiments, "isSpotlightEnabled")?.() ?? false,
          isMultitaskEnabled: () => method(experiments, "isMultitaskEnabled")?.() ?? false,
          mcpManagement: () => mcp.management,
          isMcpMultiAccountEnabled: () => method(experiments, "isMcpMultiAccountEnabled")?.() ?? false,
          isCloudAgentsDisabledByTeam: () => method(experiments, "isCloudAgentsDisabledByTeam")?.() ?? false,
          isReferenceDocsAvailable: () => false,
          mcpCustomInstructionsSection: () => productionPromptGlue?.getMcpCustomInstructionsSection() ?? null,
          mcpDiscoveryStatusSection: () => productionPromptGlue?.getMcpDiscoveryStatusSection() ?? null,
          remoteBoxSection: () => productionPromptGlue?.getRemoteBoxSection() ?? "",
          computerSection: () => productionPromptGlue?.getComputerSection() ?? null,
        });

    const runnerOptions: Record<string, unknown> = {
      inference: extensions.api("inference").port,
      diskPressureReminder: foreverBox.diskPressureReminder,
      box: localExec.box,
      ctx,
      ...(awaitCloudAgent === undefined
        ? {}
        : {
            cloudAgentWatcher: {
              awaitCompletion: (
                id: string,
                options: { readonly waitForRestart: boolean },
              ) => awaitCloudAgent(id, options),
            },
          }),
      remoteBox,
      userComputers: localExec.userComputers,
      remoteBoxHasDesktop: boxHasMonitorDesktop(),
      boxHandoff: {
        requestHelp: (request: unknown) =>
          method(extensions.api("session"), "startHandoff")?.(request)
      },
      transport: hooks.transport,
      onRunLifecycle: hooks.onRunLifecycle,
      isSharedRoomTurn,
      isSharedRoomBoxToolsEnabled: () =>
        !Boolean(method(experiments, "checkFeatureGate")?.(
          "sand_shared_room_box_tools_kill_switch"
        )) && resolveSharedRoomBoxToolsEnabled(
          process.env.SAND_SHARED_ROOM_BOX_TOOLS
        ),
      getAgentId: () => session.id,
      agentProfileProvider: hooks.agentProfileProvider,
      connectorManifests: CONNECTOR_MANIFESTS,
      ingestAttachment: hooks.ingestAttachment,
      persistImage: hooks.persistImage,
      persistMediaBytes: hooks.persistMediaBytes,
      readVideoAttachmentBytes: method(attachments, "readVideoBytes"),
      readMediaDimensions: method(attachments, "readMediaDimensions"),
      requestContext,
      localToolPermission,
      ...autoReview,
      actionAuditor,
      webSearchService: method(
        extensions.api("inference"),
        "createWebSearch"
      )?.({
        modelId: process.env.SAND_AGENT_MODEL ?? DEFAULT_SAND_MODEL,
        onRequestId: requestIdForwarder(hooks, "web-search")
      }),
      webFetchService: method(
        extensions.api("inference"),
        "createWebFetch"
      )?.({
        onRequestId: requestIdForwarder(hooks, "web-fetch")
      }),
      onComputerAction: ({ agentId, action }: any) => {
        deps.emitGatewayEvent({
          channel: "computer-action",
          payload: { agentId, ...action }
        });
      },
      systemPrompt: overrides.systemPrompt,
      isMultitaskEnabled: () =>
        method(experiments, "isMultitaskEnabled")?.() ?? false,
      isSendMessageDeliveryOwedEnabled: () =>
        method(experiments, "isSendMessageDeliveryOwedEnabled")?.() ?? false,
      isDynamicToolsEnabled: () =>
        method(experiments, "isDynamicToolsEnabled")?.() ?? false,
      isBrowserUseSubagentEnabled: () =>
        method(experiments, "isBrowserUseSubagentEnabled")?.() ?? false,
      isSpotlightEnabled: () =>
        method(experiments, "isSpotlightEnabled")?.() ?? false,
      isMcpMultiAccountEnabled: () =>
        method(experiments, "isMcpMultiAccountEnabled")?.() ?? false,
      isUnicodeTypingEnabled: () =>
        method(experiments, "isUnicodeTypingEnabled")?.() ?? false,
      isListenerPlatformConnected: (platform: string) =>
        method(
          extensions.api("automations"),
          "isListenerPlatformConnected"
        )?.(platform) ?? false,
      resolveCloudAgentTitle,
      sendToAgent,
      agentDirectory: () => {
        const roster = method(transcript, "listAgentsSync")?.() ?? [];
        return roster
          .filter((agent: any) =>
            agent.id !== session.id &&
            !agent.isGroup &&
            agent.remoteRoom == null
          )
          .map((agent: any) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description
          }));
      },
      agentGroups: () => {
        const roster = method(transcript, "listAgentsSync")?.() ?? [];
        const byId = new Map(roster.map((agent: any) => [agent.id, agent]));
        return roster
          .filter((agent: any) =>
            agent.isGroup && agent.memberIds.includes(session.id)
          )
          .map((group: any) => ({
            id: group.id,
            name: group.name,
            members: group.memberIds
              .filter((memberId: string) => memberId !== session.id)
              .map((memberId: string) => byId.get(memberId))
              .filter((member: any) => member != null)
              .map((member: any) => ({
                id: member.id,
                name: member.name,
                description: member.description
              }))
          }));
      },
      agentManagement,
      agentsRootDir: () => dirname(dirname(session.dbPath))
    };

    runnerOptions.createPromptSession = (
      onRequestId: (requestId: string) => void,
      options?: Readonly<Record<string, unknown>>,
    ) => createAgentPromptSession(
      extensions.api("inference").port,
      onRequestId,
      options,
    );

    const baseProductionResourceAccessor = createPerTurnResourceAccessor(
      remoteBox as unknown as ProductionBoxResourceOwner,
      session.id,
    );
    const probeBoxDesktop = (context: unknown): void => {
      if (boxDesktopProbe.started) return;
      boxDesktopProbe.started = true;
      void baseProductionResourceAccessor(context)
        .then(accessor => {
          boxDesktopProbe.answer = !isNoMonitorComputerUseExecutor(
            accessor.get(computerUseExecutorResource),
          );
        })
        .catch(() => {
          // No connection means no reachable desktop; the answer stays `false`.
        });
    };
    const productionResourceAccessor = async (
      context: unknown,
    ): Promise<ProductionResourceAccessor> => {
      const owner = asRemoteBoxResourceOwner(remoteBox);
      const runner = builtRunner as {
        readonly computerUse?: RemoteBoxResourceHost["computerUse"];
        setRemoteBoxTerminalsFolder?(folder: string): void;
        probeNavigationAfterComputerUse?(
          context: Context,
          connection: { readonly remoteAccessor: unknown },
        ): void;
        auditShellCommand?(
          shellKind: string,
          command: string,
          target: "box" | "user_machine",
          attribution?: { readonly turnId?: string; readonly boxId?: string },
        ): void;
      } | undefined;
      if (
        owner === undefined
        || autoReviewGate === undefined
        || runner?.computerUse === undefined
        || typeof runner.setRemoteBoxTerminalsFolder !== "function"
        || typeof runner.probeNavigationAfterComputerUse !== "function"
        || typeof runner.auditShellCommand !== "function"
        || !isAgentContext(context)
) {
        return await baseProductionResourceAccessor(context);
      }
      const remoteAutoReviewGate = {
        assertNoPendingApproval: () => autoReviewGate.assertNoPendingApproval(),
        currentModes: () => ({ ...autoReviewGate.currentModes() }),
      };
      const accessor = createRemoteBoxResourceAccessor({
        remoteBox: owner,
        remoteBoxHasDesktop: boxHasMonitorDesktop(),
        resolveBoxId: () => session.id,
        getConversationId: () => session.id,
        setRemoteBoxTerminalsFolder: folder => runner.setRemoteBoxTerminalsFolder?.(folder),
        autoReviewGate: remoteAutoReviewGate,
        auditShellCommand: (_agentId, kind, command, _target, attribution) =>
          runner.auditShellCommand?.(kind, command, "box", attribution),
        computerUse: runner.computerUse,
        probeNavigationAfterComputerUse: (probeContext, connection) =>
          runner.probeNavigationAfterComputerUse?.(probeContext, connection),
        ...(autoReview.autoReviewClassifierExecutor === undefined
          ? {}
          : { autoReviewClassifierExecutor: autoReview.autoReviewClassifierExecutor }),
      });
      return asProductionResourceAccessor(accessor);
    };
    const localProductionResourceAccessor = createPerTurnResourceAccessor(
      localExec.box as ProductionBoxResourceOwner,
      session.id,
    );
    runnerOptions.createResourceAccessor = productionResourceAccessor;
    runnerOptions.createSummarizationHandler = (
      summarizationSession: SummarizationPromptSession,
      options?: { preserveLatestImage?: boolean },
    ) => new SummarizationHandler(summarizationSession, false, {
      enableReduceInputsRetry: true,
      maxPromptChars: SAND_SUMMARIZATION_MAX_PROMPT_CHARS,
      maxOutputTokens: 32_000,
      preserveLatestImage: options?.preserveLatestImage ?? false,
    });
    runnerOptions.createConversationActionReceiver = () =>
      new NoopConversationActionReceiver();
    // Dormant direct owner for the immutable retry/checkpoint boundary. The
    // current clean runner does not consume this until the real Agent stream
    // join is released; keeping the factory here makes the owner reachable
    // without invoking runStream or replacing the fail-closed runStep port.
    runnerOptions.createStreamAttempt = createStreamAttempt;
    // This is the exact generated redaction/RESUME projection used by the
    // immutable stream handoff. It remains a dormant typed option: the clean
    // runner does not call it until the real Agent stream join is promoted.
    runnerOptions.createTurnAgentRunStreamInput = createTurnAgentRunStreamInput;
    // Direct constructor-side stream owner. This remains dormant until a
    // dependency-closed built Agent is supplied by the real turn join.
    runnerOptions.createTurnAgentStreamStart = createTurnAgentStreamStart;

    // Host-owned production caller for the recovered constructor. The caller
    // supplies the typed per-turn prompt/action and summarization identities;
    // resource readiness and blob ownership remain fixed to this session.
    runnerOptions.createProductionTurnAgentOwner = (
      input: Omit<
        ProductionTurnAgentOwnerInput,
        "createResourceAccessor" | "blobStore"
      >,
    ) => {
      if (
        session.agentStore == null
        || typeof session.agentStore.getBlobStore !== "function"
      ) {
        throw new TypeError("production Agent blob store is not bound");
      }
      return createProductionTurnAgentOwner({
        ...input,
        createResourceAccessor: localProductionResourceAccessor,
        createRemoteBoxResourceAccessor: productionResourceAccessor,
        blobStore: getAgentBlobStore(
          session.agentStore as Parameters<typeof getAgentBlobStore>[0],
        ),
      });
    };
    runnerOptions.createProductionTurnAgentRunInput =
      createProductionTurnAgentRunInput;

    if (session.agentStore != null && typeof session.agentStore.getBlobStore === "function") {
      runnerOptions.blobStore = getAgentBlobStore(
        session.agentStore as unknown as Parameters<typeof getAgentBlobStore>[0],
      );
    }

    if (!isSharedRoomTurn) {
      transcriptMirrorForTurn = deps.createTranscriptMirror?.({
        transcriptsDir,
        session,
        pool: getMirrorOffloadPool,
        reportOutcome: report => {
          method(telemetry.brain ?? {}, "reportJournalOutcome")?.(report);
        },
        isJournalEnabled: async () =>
          await method(experiments, "checkGate")?.(
            "sand_new_transcript_journal"
          ) ?? false
      }) as TurnSettleHost["transcriptMirror"] | undefined;
      Object.assign(runnerOptions, {
        transcriptMirror: transcriptMirrorForTurn,
        mcp: mcp.mcp,
        mcpManagement: mcp.management,
        agentState: agentStateOwner,
        generateImageService: method(
          attachments,
          "createGenerateImageService"
        )?.({
          persistImage: hooks.persistImage,
          onRequestId: requestIdForwarder(hooks, "generate-image")
        }),
        generateImageResourceAccessor: method(
          attachments,
          "createGenerateImageResourceAccessor"
        )?.(dirname(session.dbPath)),
        getAgentDir: () => dirname(session.dbPath),
        uploadAttachmentsIntoBox: (hostPaths: readonly string[]) =>
          method(attachments, "stageIntoBox")?.(session.id, hostPaths),
        agentStore: session.agentStore,
        conversationSizeGuard: () =>
          sessionApi.store?.ensureConversationCapacityForTurn?.(session),
        memoryStore: session.memory,
        // `isMemorableExchange` was never passed, so `turn-settle.ts:354` always
        // saw `undefined` and refused to write memory for any exchange. The gate
        // itself is unchanged — `sand_memory_dreaming` is still not enabled; what
        // changed is that the predicate the settle host already asks for is
        // actually supplied.
        isMemorableExchange: isMemorableExchange,
        userMemory: method(memory, "createUserMemory")?.({
          agentId: session.id,
          resolveAgentName: resolveAgentDisplayName
        }),
        projectMemory: method(memory, "createProjectMemory")?.({
          agentDir: dirname(session.dbPath),
          agentId: session.id,
          resolveAgentName: resolveAgentDisplayName
        }),
        memorySnapshots: session.db,
        profilePromptSnapshots: session.db,
        episodeProgress: session.db,
        automationStore: session.automations,
        workflowStore: session.workflows,
        channelStore: session.channels
      });
    }

    const projectedLocalToolPermission = asLocalToolPermissionProjection(
      localToolPermission,
    );
    // The OTHER half of the same live controller, for the turn shell. The
    // toolset projection above is not a substitute: it carries neither
    // `beginTurn` nor `directionEpoch`, and passing it here would leave every
    // turn running under epoch 0 with nothing failing.
    const turnLocalToolPermission = asTurnLocalToolPermissionEpoch(
      localToolPermission,
    );

    const hostDependencies = (): ProductionTurnHostDependencies => {
      const readMediaDimensions = method(attachments, "readMediaDimensions");
      const uploadFile = method(remoteBox, "uploadFile");
      const downloadFile = method(remoteBox, "downloadFile");
      const watchCloudAgent = createRunnerCloudWatch(builtRunner);
      const cloudAgent = (() => {
        const launchedIds = cloudAgents.launchedIds;
        if (
          !isCloudAgentApi(cloudAgents)
          || !(launchedIds instanceof Set)
          || uploadFile === undefined
        ) return undefined;
        const reviewAction: NonNullable<CloudAgentToolDeps["reviewAction"]> | undefined =
          productionContext === undefined || autoReviewGate === undefined
            ? undefined
            : async ({ args, toolCallId, images, signal }) => {
              const instructions = autoReviewGate.userInstructions();
              const reviewOptions = {
                mode: autoReviewGate.currentModes().cloudAgent,
                agentId: session.id,
                ...(autoReviewController === undefined
                  ? {}
                  : { autoReviewController }),
                ...(instructions === undefined
                  ? {}
                  : { userAutoRunInstructions: instructions }),
                getApprovalExpiryPolicy: () =>
                  sandAutoReviewApprovalExpiryPolicy("turn"),
              };
              const lifecycleTarget = buildSandCloudAgentLifecycleReviewTarget({
                action: args.action,
                ...(args.agent_id === undefined ? {} : { agent_id: args.agent_id }),
                ...(args.title === undefined ? {} : { title: args.title }),
              });
              if (lifecycleTarget !== undefined) {
                const result = await reviewSandCloudAgentLifecycleAction({
                  ctx: productionContext,
                  target: lifecycleTarget,
                  options: reviewOptions,
                  ...(signal === undefined ? {} : { signal }),
                });
                return { allowed: result.allowed, reason: result.reason ?? "" };
              }
              const target = buildSandCloudAgentReviewTarget(
                args,
                describeSandCloudAgentReviewImages(
                  images.map(image => image.path),
                  images,
                ),
              );
              if (target === undefined) return { allowed: true, reason: "" };
              const result = await reviewSandCloudAgentAction({
                ctx: productionContext,
                target,
                toolCallId,
                ...(signal === undefined ? {} : { signal }),
                options: {
                  ...reviewOptions,
                  classify: async (classifyContext, classifyTarget, mode, id) =>
                    await runSandAutoReviewClassifier({
                      ctx: classifyContext,
                      resourceAccessor: await productionResourceAccessor(classifyContext),
                      toolCallId: id,
                      mode,
                      buildTarget: () => buildSandCloudAgentRiskTarget({
                        target: classifyTarget,
                        ...(instructions === undefined
                          ? {}
                          : { userAutoRunInstructions: instructions }),
                      }),
                      loadConversationContext: async () =>
                        await extractProductionTurnAutoReviewConversationContext(
                          classifyContext,
                          agentStateOwner,
                        ),
                      errorReason: SAND_CLOUD_AGENT_CLASSIFIER_ERROR_REASON,
                    }),
                },
              });
              return { allowed: result.allowed, reason: result.reason ?? "" };
            };
        return {
          api: cloudAgents,
          launchedIds,
          agentDir: dirname(session.dbPath),
          ...(downloadFile === undefined
            ? {}
            : {
                readBoxFile: async (
                  cloudContext: CloudAgentToolContext,
                  boxPath: string,
                ) => await downloadFile(cloudContext, session.id, boxPath),
              }),
          writeBoxFile: async (
            cloudContext: CloudAgentToolContext,
            boxPath: string,
            data: Uint8Array,
          ) => await uploadFile(cloudContext, session.id, boxPath, data),
          ...(awaitCloudAgent === undefined
            ? {}
            : {
                cloudAgentWatcher: () => ({
                  awaitCompletion: (id: string, options: { waitForRestart: boolean }) =>
                    awaitCloudAgent(id, options),
                }),
              }
          ),
          ...(watchCloudAgent === undefined ? {} : { watch: watchCloudAgent }),
          ...(reviewAction === undefined ? {} : { reviewAction }),
        };
      })();

      const sendMessage = {
        getIngestAttachment: () => hooks.ingestAttachment,
        resolveCloudAgentTitle,
        ...(readMediaDimensions === undefined
          ? {}
          : { readMediaDimensions }),
        onSendMessage: (message: Record<string, unknown>, timestampMs: number) => {
          hooks.transport.onUpdate({
            type: "send-message",
            message: { ...message, type: String(message.type ?? "text") },
            timestampMs,
          });
          return hooks.transport.lastSentMessageId?.();
        },
      };
      const reaction = {
        react: (args: { messageAddress: string; emoji: string }) => {
          hooks.transport.onUpdate({ type: "react-to-message", ...args });
        },
      };
      const listenerPlatformConnected = method(
        extensions.api("automations"),
        "isListenerPlatformConnected",
      );
      const reviewAutomationWrite: NonNullable<
        ProductionTurnHostDependencies["state"]
      >["reviewAutomationWrite"] =
        productionContext === undefined || autoReviewGate === undefined
          ? undefined
          : async (review: AutomationReview, toolCallId?: string) => {
            if (toolCallId === undefined || toolCallId.length === 0) {
              return {
                allowed: false,
                reason: "Auto-review requires a tool call identity.",
              };
            }
            const trigger = parseStoredTrigger(review.spec.trigger);
            if (trigger === null) {
              return {
                allowed: false,
                reason: "This routine trigger could not be reviewed.",
              };
            }
            const target = {
              operation: review.operation,
              id: review.id ?? review.referencedWorkflows[0]?.id ?? "",
              spec: {
                name: review.spec.name,
                prompt: review.spec.prompt,
                trigger,
                isEnabled: review.spec.isEnabled ?? true,
              },
              referencedWorkflows: review.referencedWorkflows,
              ...(review.referencingRoutines === undefined
                ? {}
                : { referencingRoutines: review.referencingRoutines }),
            };
            const instructions = autoReviewGate.userInstructions();
            const result = await reviewSandAutomationWrite({
              ctx: productionContext,
              target,
              toolCallId,
              options: {
                mode: autoReviewGate.currentModes().automationWrite,
                agentId: session.id,
                ...(autoReviewController === undefined
                  ? {}
                  : { autoReviewController }),
                ...(instructions === undefined
                  ? {}
                  : { userAutoRunInstructions: instructions }),
                getApprovalExpiryPolicy: () =>
                  sandAutoReviewApprovalExpiryPolicy("turn"),
                classify: async (classifyContext, classifyTarget, mode, id) =>
                  await runSandAutoReviewClassifier({
                    ctx: classifyContext,
                    resourceAccessor: await productionResourceAccessor(classifyContext),
                    toolCallId: id,
                    mode,
                    buildTarget: () => buildSandAutomationWriteRiskTarget({
                      target: classifyTarget,
                      ...(instructions === undefined
                        ? {}
                        : { userAutoRunInstructions: instructions }),
                    }),
                    loadConversationContext: async () =>
                      await extractProductionTurnAutoReviewConversationContext(
                        classifyContext,
                        agentStateOwner,
                      ),
                    errorReason: SAND_AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON,
                  }),
              },
            });
            return { allowed: result.allowed, reason: result.reason ?? "" };
          };
      const onListenerRoutineSaved: NonNullable<
        ProductionTurnHostDependencies["state"]
      >["onListenerRoutineSaved"] =
        listenerPlatformConnected === undefined
          ? undefined
          : async triggerValue => {
            const trigger = parseStoredTrigger(triggerValue);
            if (trigger === null) return undefined;
            return (await surfaceListenerConnectCards({
              trigger,
              platformsInTrigger: value => {
                const parsed = parseStoredTrigger(value);
                return parsed === null ? [] : listenerPlatformsInTrigger(parsed);
              },
              isListenerPlatformConnected: async platform =>
                Boolean(await listenerPlatformConnected(platform)),
              emit: card => {
                hooks.transport.onUpdate({
                  type: "send-message",
                  message: card,
                  timestampMs: Date.now(),
                });
              },
              displayName: platform => platform === "slack" ? "Slack" : "GitHub",
            })) ?? undefined;
          };
      const state = agentStateOwner === undefined
        ? undefined
        : {
            state: agentStateOwner,
            ...(session.automations != null
              && typeof (session.automations as { list?: unknown }).list === "function"
              ? {
                  automationStore: session.automations as {
                    list(): readonly AutomationRecord[];
                  },
                }
              : {}),
            ...(session.workflows != null
              && typeof (session.workflows as { list?: unknown }).list === "function"
              ? {
                  workflowStore: session.workflows as {
                    list(): readonly WorkflowRecord[];
                  },
                }
              : {}),
            parseTrigger: parseStoredTrigger,
            ...(reviewAutomationWrite === undefined ? {} : { reviewAutomationWrite }),
            ...(onListenerRoutineSaved === undefined ? {} : { onListenerRoutineSaved }),
          };

      const subagentManagement = createRunnerSubagentManagement(builtRunner);
      const projectedActionAuditor = asActionAuditor(actionAuditor);
      const autoReviewProjection: ProductionTurnAutoReviewHostProjection | undefined =
        autoReviewController === undefined || autoReviewGate === undefined
          ? undefined
          : {
              controller: autoReviewController,
              agentId: session.id,
              getModes: () => autoReviewGate.currentModes(),
              getInstructions: () => autoReviewGate.userInstructions(),
              getApprovalExpiryPolicy: () =>
                sandAutoReviewApprovalExpiryPolicy("turn"),
              requestContext: new RequestContext({
                env: new RequestContextEnv({
                  smartModeClassifierAutoModeEnabled: true,
                }),
              }),
              getShellApprovalState: surface =>
                autoReviewGate.shellApprovalState(surface),
              enforceModelFacingShellUiAutomationGuard:
                autoReviewGate.currentModes().hostShell === "enforce"
                || autoReviewGate.currentModes().computer === "enforce",
              ...(projectedActionAuditor === undefined
                ? {}
                : { actionAuditor: projectedActionAuditor }),
              ...(projectedLocalToolPermission === undefined
                ? {}
                : { localToolPermission: projectedLocalToolPermission }),
              ...(listenerPlatformConnected === undefined
                ? {}
                : {
                    isListenerPlatformConnected: async (platform: string) =>
                      Boolean(await listenerPlatformConnected(platform)),
                  }),
            };
      return {
        isMultitaskEnabled: () =>
          method(experiments, "isMultitaskEnabled")?.() ?? false,
        sendMessage,
        sendToAgent: {
          getSelfAgentId: () => session.id,
          sendToAgent: (
            targetId: string,
            text: string,
            images,
            priority,
          ) => sendToAgent(targetId, text, images, priority === true),
        },
        reaction,
        agentManagement,
        ...(state === undefined ? {} : { state }),
        ...(!isSharedRoomTurn && mcp.management != null
          && typeof mcp.management.listPlugins === "function"
          ? { mcpManagement: mcp.management }
          : {}),
        ...(cloudAgent === undefined ? {} : { cloudAgent }),
        ...(subagentManagement === undefined
          ? {}
          : { subagentManagement }),
        ...(autoReviewProjection === undefined
          ? {}
          : { autoReview: autoReviewProjection }),
      };
    };

    const createTurnToolsetFactoryProvider = (
      dependencies: ProductionTurnHostDependencies,
      turnInputs?: ProductionTurnToolInputs,
    ): TurnToolsetHostFactoryProvider => {
      const cloudAgent = dependencies.cloudAgent;
      const mcpManagement = dependencies.mcpManagement;
      const fileTransferController = createHostFileTransferController();
      const provider: TurnToolsetHostFactoryProvider = {
      createSendMessageToolInputs: turn => ({
        dependencies: turn.emitUpdate === undefined
          ? dependencies.sendMessage
          : {
              ...dependencies.sendMessage,
              onSendMessage: (message, timestampMs) => {
                turn.emitUpdate?.({
                  type: "send-message",
                  message: { ...message, type: String(message.type ?? "text") },
                  timestampMs,
                  ...(turn.ackToken === undefined
                    ? {}
                    : { ackToken: turn.ackToken }),
                });
                return hooks.transport.lastSentMessageId?.();
              },
            },
      }),
      createSendToAgentToolInputs: () => ({
        dependencies: dependencies.sendToAgent,
      }),
      createReactionToolInputs: turn => ({
        dependencies: turn.emitUpdate === undefined
          ? dependencies.reaction
          : {
              ...dependencies.reaction,
              react: args => turn.emitUpdate?.({ type: "react-to-message", ...args }),
            },
      }),
      createAgentManagementToolInputs: () => ({
        dependencies: dependencies.agentManagement,
      }),
      createBoxAwaitToolInputs: (turn, _props): TurnAwaitToolFactoryInput => ({
        resourceAccessor: (() => {
          if (turn.remoteBoxResourceAccessor === undefined) {
            throw new TypeError("remote box resource accessor is not bound");
          }
          return turn.remoteBoxResourceAccessor as unknown as TurnAwaitToolFactoryInput["resourceAccessor"];
        })(),
        options: {
          toolName: SAND_BOX_AWAIT_SHELL_TOOL_NAME,
          toolIdentifier: "BOX_AWAIT",
          terminalsFolder: () => method(remoteBox, "getTerminalsFolder")?.() ?? "",
          enableSubagentAwaiting: false,
          defaultBlockUntilMs: 30_000,
          enableJobCompletionNotifications: true,
        },
      }),
      createExternalReadToolInputs: (_turn, props): TurnReadToolFactoryInput => ({
        resourceAccessor: props.resourceAccessor as unknown as TurnReadToolFactoryInput["resourceAccessor"],
        formattingOptions: SAND_READ_FORMATTING_OPTIONS,
        promptVersion: "latest",
        options: {
          toolName: SAND_EXTERNAL_READ_TOOL_NAME,
          toolIdentifier: "EXTERNAL_READ",
          toolDescription: SAND_EXTERNAL_READ_TOOL_DESCRIPTION,
          // The immutable Mac and Windows carriers contain the lazy Piscina
          // producer but omit pdf-worker.{js,ts}. Leaving the extractor absent
          // preserves ordinary Read while making the unrecoverable PDF branch
          // fail closed in createReadTool.
        },
      }),
      createBoxReadToolInputs: (turn, _props): TurnReadToolFactoryInput => {
        if (turn.remoteBoxResourceAccessor === undefined) {
          throw new TypeError("remote box resource accessor is not bound");
        }
        return {
          resourceAccessor: turn.remoteBoxResourceAccessor as unknown as TurnReadToolFactoryInput["resourceAccessor"],
          formattingOptions: SAND_READ_FORMATTING_OPTIONS,
          promptVersion: "latest",
          options: {
            toolName: SAND_BOX_READ_TOOL_NAME,
            toolIdentifier: "READ",
            toolDescription: SAND_BOX_READ_TOOL_DESCRIPTION,
          },
        };
      },
      ...(turnInputs?.webSearch === undefined
        && method(extensions.api("inference"), "createWebSearch") === undefined
        ? {}
        : {
            createWebSearchToolInputs: (_turn, props): TurnWebSearchToolFactoryInput => {
              const webSearch = props.webSearch
                ?? turnInputs?.webSearch
                ?? createTurnWebAndAwaitProjections(props).webSearch;
              if (webSearch === undefined) throw new TypeError("web search service is not bound");
              return { dependencies: webSearch as unknown as TurnWebSearchToolFactoryInput["dependencies"] };
            },
          }),
      ...(turnInputs?.webFetch === undefined
        && method(extensions.api("inference"), "createWebFetch") === undefined
        ? {}
        : {
            createWebFetchToolInputs: (_turn, props): TurnWebFetchToolFactoryInput => {
              const webFetch = props.webFetch
                ?? turnInputs?.webFetch
                ?? createTurnWebAndAwaitProjections(props).webFetch;
              if (webFetch === undefined) throw new TypeError("web fetch service is not bound");
              return { dependencies: webFetch as unknown as TurnWebFetchToolFactoryInput["dependencies"] };
            },
          }),
      ...(turnInputs?.externalAwait === undefined
        && method(remoteBox, "getTerminalsFolder") === undefined
        ? {}
        : {
            createExternalAwaitToolInputs: (_turn, props): TurnAwaitToolFactoryInput => {
              const externalAwait = props.externalAwait
                ?? turnInputs?.externalAwait
                ?? createTurnWebAndAwaitProjections(props).externalAwait;
              if (externalAwait === undefined) throw new TypeError("external await service is not bound");
              return {
                resourceAccessor: externalAwait.resourceAccessor as unknown as TurnAwaitToolFactoryInput["resourceAccessor"],
                options: externalAwait.options,
                ...(externalAwait.promptVersion === undefined
                  ? {}
                  : { promptVersion: externalAwait.promptVersion }),
              };
            },
          }),
        ...(mcpManagement === undefined
          ? {}
          : {
              createMcpManagementToolInputs: (): TurnMcpManagementToolFactoryInput => ({
          management: mcpManagement,
          getRequestingAgentId: () => session.id,
          isAwaitingUserSelection: () => {
            const owner = builtRunner as { isRunAwaitingUserSelection?: () => boolean } | undefined;
            return owner?.isRunAwaitingUserSelection?.() === true;
          },
          isMultiAccountEnabled: () =>
            method(experiments, "isMcpMultiAccountEnabled")?.() ?? false,
          emitConnectorCard: emission => {
            hooks.transport.onUpdate({
              type: "send-message",
              message: connectorCardEmissionToMessage(emission),
              timestampMs: Date.now(),
            });
          },
              }),
            }),
        ...(fileTransferController === undefined
          ? {}
          : {
              // CopyToBox/CopyFromBox move bytes between this agent's box and a
              // connected computer. Both endpoints are live ports already: the
              // box through remoteBox, the computer through the same local-exec
              // bridge ExternalShell runs on.
              createFileTransferToolInputs: () => ({
                controller: fileTransferController,
              }),
            }),
        ...(dependencies.subagentManagement === undefined
          ? {}
          : {
              createSubagentManagementToolInputs: () => ({
                controller: dependencies.subagentManagement as SubagentManagementController,
              }),
            }),
        ...(method(mcp.mcp, "getTools") === undefined
          ? {}
          : {
              // GetMcpTools/CallMcpTool. The descriptor source is the Agent's
              // own per-turn snapshot, the only synchronous truth about what this
              // turn can reach. An empty one keeps the pair absent instead of
              // offering a tool whose only answer is "nothing here".
              createMcpMetaToolInputs: (_turn, props): TurnMcpMetaToolFactoryInput => ({
                resourceAccessor: props.resourceAccessor as TurnMcpMetaToolFactoryInput["resourceAccessor"],
                getMcpTools: () => liveMcpToolsForTurn(_turn, props),
                callOptions: {},
              }),
            }),
        ...(!isSharedRoomTurn && cloudAgent !== undefined
          ? {
              createCloudAgentToolInputs: (): TurnCloudAgentToolFactoryInput => ({
                dependencies: {
                  api: cloudAgent.api,
                  launchedIds: cloudAgent.launchedIds,
                  agentDir: cloudAgent.agentDir,
                  writeBoxFile: cloudAgent.writeBoxFile,
                  ...(cloudAgent.readBoxFile === undefined
                    ? {}
                    : { readBoxFile: cloudAgent.readBoxFile }),
                  ...(cloudAgent.watch === undefined
                    ? {}
                    : { watch: cloudAgent.watch }),
                  ...(cloudAgent.reviewAction === undefined
                    ? {}
                    : { reviewAction: cloudAgent.reviewAction }),
                },
              }),
            }
          : {}
        ),
      };
      const state = dependencies.state;
      if (state === undefined) return provider;
      return {
        ...provider,
        createStateToolInputs: () => ({
          dependencies: state,
        }),
      };
    };

    const createTurnToolInputs = (input: ProductionTurnToolInputs) => {
      const dependencies = hostDependencies();
      const projected = createProductionTurnToolInputs(
        input,
        {
          ...(createTurnToolProjections?.(input) ?? {}),
          ...createTurnWebAndAwaitProjections(input),
          ...(hooks.emitUpdate === undefined
            ? {}
            : { emitUpdate: hooks.emitUpdate }),
        },
      );
      return {
        ...projected,
        hostDependencies: dependencies,
        turnToolsetFactoryProvider: createTurnToolsetFactoryProvider(
          dependencies,
          projected,
        ),
      };
    };

    const persistAnnouncedAgentProfile: TurnSettleHost["persistAnnouncedAgentProfile"] = (
      snapshots,
      snapshot,
      identity,
    ) => {
      const profilePromptSnapshotStore = asPromptSnapshotStore(snapshots);
      productionSystemPromptAssembly?.persistAnnouncedAgentProfile(
        profilePromptSnapshotStore,
        snapshot,
        identity,
      );
    };

    /**
     * The settle host of ONE agent.
     *
     * It used to be a nullary closure over `session.id` and `builtRunner`, so
     * `createSubagentRunner` — which builds its child from this very
     * composition's `runnerOptions` — got the parent's journal key, the parent's
     * blob store and the parent's `AgentStore2`. The child then appended its own
     * turn to the parent's conversation, and the parent's next checkpoint looked
     * like history moving backwards. The scope is now an argument: a subagent
     * passes its own id, its own runner and its own store.
     */
    const createProductionTurnSettleHost = (
      scope: {
        readonly agentId: string;
        readonly isSubagentRunner: boolean;
        readonly runner: unknown;
        readonly agentStore: ProductionCheckpointStore;
      },
    ): TurnSettleHost =>
      createProductionTurnSettleHostForScope(
        {
          agentId: scope.agentId,
          isSubagentRunner: scope.isSubagentRunner,
          runner: scope.runner as ProductionTurnSettleRunner | undefined,
          agentStore: scope.agentStore,
        },
        {
          ...(transcriptMirrorForTurn === undefined
            ? {}
            : { transcriptMirror: transcriptMirrorForTurn }),
          persistAnnouncedAgentProfile,
          settlesAsSubagent: isSharedRoomTurn,
        },
      );

    const parentSettleScope = (): {
      agentId: string;
      isSubagentRunner: boolean;
      runner: unknown;
      agentStore: ProductionCheckpointStore;
    } => {
      const store = session.agentStore;
      if (store == null) {
        throw new TypeError("production Agent checkpoint store is not bound");
      }
      return {
        agentId: session.id,
        isSubagentRunner: false,
        runner: builtRunner,
        agentStore: store as unknown as ProductionCheckpointStore,
      };
    };

    runnerOptions.createProductionTurnToolsetHost = (
      input: Omit<ProductionTurnToolsetHostInput, "factoryProvider">,
    ) => createProductionTurnToolsetHost({
      ...input,
      factoryProvider: createTurnToolsetFactoryProvider(
        hostDependencies(),
      ),
      ...(projectedLocalToolPermission === undefined
        ? {}
        : { localToolPermission: projectedLocalToolPermission }),
    });

    if (productionContext !== undefined && productionPromptGlue !== undefined) {
      const turnRequestContext = productionRequestContext;
      const turnAutoReviewGate = autoReviewGate;
      if (turnRequestContext === undefined || turnAutoReviewGate === undefined) {
        throw new TypeError("production turn context owners are not bound");
      }
      const autoReviewModes = autoReview.autoReviewModes ?? {
        hostShell: "off",
        boxShell: "off",
        mcp: "off",
        computer: "off",
        automationWrite: "off",
        cloudAgent: "off",
        subagentLaunch: "off",
      };
      /** Agents of this runner that have a turn in flight right now. */
      const liveSubagents = new Set<string>();
      // `subagentConfigs` used to be the literal `[]` and the Task tool was
      // offered anyway, so every call died in `task-subagent-preparation.ts:494`
      // with `ToolCallArgParseError("No subagent types are available.")`. It is a
      // getter because the flags behind it (monitor, multitask, browserUse) are
      // only known once the box connection and the experiment gates have been
      // read, which happens after this object is built.
      const baseTurn: TurnToolsetTurnInput = {
        autoReviewModes,
        get subagentConfigs() {
          return buildSandSubagentConfigsForRun({
            isSubagentRunner: false,
            remoteBoxHasDesktop: boxHasMonitorDesktop(),
            remoteBoxAvailable: method(remoteBox, "isAvailable")?.() !== false,
            browserUseSubagentEnabled: method(experiments, "isBrowserUseSubagentEnabled")?.() ?? false,
            isSystemPromptOverridden: typeof overrides.systemPrompt === "string",
            isMultitaskEnabled: method(experiments, "isMultitaskEnabled")?.() ?? false,
          });
        },
      };
      const staticModelId = process.env.SAND_AGENT_MODEL ?? DEFAULT_SAND_MODEL;
      const lazyToolHost = (isSubagentRunner = false) => createProductionTurnToolsetHost({
        turn: baseTurn,
        factoryProvider: createTurnToolsetFactoryProvider(hostDependencies()),
        // Hardcoded `false` before: the subagent's toolset was built as if it
        // were the parent, so `buildTurnTools` offered it `Task` — and a
        // subagent that could dispatch a Task had no session map to dispatch
        // into, which is how nesting got past the depth limit.
        isSubagentRunner,
        isSharedRoomRunner: isSharedRoomTurn,
        isBoxScopedSubagent: false,
        isComputerUseSubagent: false,
        isBrowserUseSubagent: false,
        isSystemPromptOverridden: typeof overrides.systemPrompt === "string",
        remoteBoxHasDesktop: boxHasMonitorDesktop(),
        getConversationId: () => session.id,
        getRemoteBoxAvailable: () => method(remoteBox, "isAvailable")?.() !== false,
        cloudAgentsDisabledByTeam: () => method(experiments, "isCloudAgentsDisabledByTeam")?.() ?? false,
        spotlightEnabled: () => method(experiments, "isSpotlightEnabled")?.() ?? false,
        isDynamicToolsEnabled: () => method(experiments, "isDynamicToolsEnabled")?.() ?? false,
        isMultitaskEnabled: () => method(experiments, "isMultitaskEnabled")?.() ?? false,
        isSharedRoomBoxToolsEnabled: () => resolveSharedRoomBoxToolsEnabled(process.env.SAND_SHARED_ROOM_BOX_TOOLS),
        ...(projectedLocalToolPermission === undefined
          ? {}
          : { localToolPermission: projectedLocalToolPermission }),
      });
      /**
       * The base conversation state of ONE scope.
       *
       * It used to close over `builtRunner`, which is always the PARENT's
       * runner, so a subagent started its turn from the parent's durable
       * history. Its checkpoint was then the parent's turns plus the subagent's
       * turn, written into the parent's journal key — which is how the parent's
       * next, shorter checkpoint became "durable conversation turns moved
       * backwards". A subagent reads its own store and starts empty.
       */
      const getProductionConversationState = (scope?: {
        readonly subagentStore?: SubagentConversationStore;
      }): ConversationStateStructure => {
        if (scope?.subagentStore !== undefined) {
          return scope.subagentStore.getConversationStateStructure();
        }
        const runner = builtRunner as {
          getAgentConversationStateStructure?: () => unknown;
        } | undefined;
        if (typeof runner?.getAgentConversationStateStructure === "function") {
          return runner.getAgentConversationStateStructure() as ConversationStateStructure;
        }
        const store = session.agentStore;
        if (store != null && typeof store.getConversationStateStructure === "function") {
          return store.getConversationStateStructure();
        }
        throw new TypeError("production Agent conversation state is not bound");
      };
      // The run shell used to be built once, for the parent, and the child got
      // `productionTurnRunShell: undefined`. `SandAgentRunner.run` then had
      // neither a shell nor a `runStep`, returned `undefined`, and
      // `createSubagentRunner` threw `TypeError("production subagent result is
      // not bound")` on the first Task call — so a non-empty `subagentConfigs`
      // would only have moved the failure. Building it per scope is what makes a
      // subagent a real runner: its own agent id, its own empty subagent session
      // map (a subagent cannot dispatch or manage siblings), and its own tool
      // host with `isSubagentRunner: true`.
      const buildProductionTurnRunShellInput = (scope: {
        readonly agentId: string;
        readonly isSubagentRunner: boolean;
        readonly subagentType: string | undefined;
        /** The subagent's own durable conversation; absent for the parent. */
        readonly subagentStore?: SubagentConversationStore;
        /** Resolves once the subagent's durable root has been read. */
        readonly ready?: Promise<void>;
        /**
         * The runner that owns this scope. Read lazily by the settle host,
         * because a subagent's shell is built BEFORE its runner exists and the
         * caller fills this in once `buildRunner` has returned it. Falling back
         * to `builtRunner` here is the whole defect, so an unfilled slot on a
         * subagent scope is a hard error rather than a silent parent fallback.
         */
        scopeRunner?: unknown;
        /**
         * The direction the PARENT is running under, for a subagent's scope.
         *
         * A subagent must never read its own id out of the controller: that id
         * is not in the controller's `directionEpochs` map, so the answer is 0
         * even while the parent is several turns deep, and the child's scoped
         * tool calls would then compare remembered refusals against the wrong
         * direction.
         */
        readonly inheritedDirectionEpoch?: number;
      }): ReturnType<typeof createProductionTurnRunShellHostInput> => {
        const hostInput = createProductionTurnRunShellHostInput({
        createAgentOwnerInput: ({ requestId, runOptions, context, cancelThisRun, emitUpdate }) => {
          if (session.agentStore == null || typeof session.agentStore.getBlobStore !== "function") {
            throw new TypeError("production Agent blob store is not bound");
          }
          const liveAutoReviewModes = turnAutoReviewGate.currentModes();
          const autoReviewRequestContext = new RequestContext({
            env: new RequestContextEnv({
              smartModeClassifierAutoModeEnabled: true,
            }),
          });
          const autoReviewInstructions = turnAutoReviewGate.userInstructions();
          const createShellReview = (
            mode: TurnShellAutoReviewInput["mode"],
            surface: TurnShellAutoReviewInput["surface"],
            approvalSurface: "host_shell" | "box_shell",
          ): TurnShellAutoReviewInput | undefined => mode === "off"
            ? undefined
            : {
                mode,
                agentId: session.id,
                surface,
                requestContext: autoReviewRequestContext,
                ...(autoReviewController === undefined
                  ? {}
                  : { controller: autoReviewController }),
                getApprovalExpiryPolicy: () =>
                  sandAutoReviewApprovalExpiryPolicy("turn"),
                smartModeShellApprovalState:
                  turnAutoReviewGate.shellApprovalState(approvalSurface),
                ...(autoReviewInstructions === undefined
                  ? {}
                  : {
                      userAutoRunInstructions: {
                        allowInstructions: autoReviewInstructions.allowInstructions,
                        blockInstructions: autoReviewInstructions.blockInstructions,
                      },
                    }),
                enforceModelFacingShellUiAutomationGuard:
                  liveAutoReviewModes.hostShell === "enforce"
                  || liveAutoReviewModes.computer === "enforce",
              };
          const hostShellReview = createShellReview(
            liveAutoReviewModes.hostShell,
            "host_machine",
            "host_shell",
          );
          const boxShellReview = createShellReview(
            liveAutoReviewModes.boxShell,
            "isolated_box",
            "box_shell",
          );
          const turn: TurnToolsetTurnInput = {
            ...baseTurn,
            emitUpdate,
            cancelThisRun,
            onToolsetBuilt: toolNames => {
              lastTurnToolNames.clear();
              for (const name of toolNames) lastTurnToolNames.add(name);
            },
            ...(runOptions.ackToken === undefined
              ? {}
              : { ackToken: runOptions.ackToken }),
            ...(hostShellReview === undefined && boxShellReview === undefined
              ? {}
              : {
                  shellAutoReview: {
                    ...(hostShellReview === undefined
                      ? {}
                      : { host: hostShellReview }),
                    ...(boxShellReview === undefined
                      ? {}
                      : { box: boxShellReview }),
                  },
                }),
          };
          return {
            context,
            conversationId: scope.agentId,
            requestId,
            inference: createTypedInferenceOwner(extensions.api("inference").port),
            onRequestId: requestIdForwarder(hooks, "agent"),
            isSubagentRunner: scope.isSubagentRunner,
            isSilenceAllowed: runOptions.isSilenceAllowed === true,
            ...(runOptions.ackToken === undefined
              ? {}
              : { ackToken: runOptions.ackToken }),
            canUseSelfSummary: () => true,
            cancelThisRun: reason => {
              const runner = builtRunner as { interrupt?: (value: string) => boolean } | undefined;
              runner?.interrupt?.(reason.reason);
            },
            createResourceAccessor: localProductionResourceAccessor,
            createRemoteBoxResourceAccessor: productionResourceAccessor,
            createTurnLocalResourceProjectionInput: baseAccessor => {
              const runner = builtRunner;
              if (runner === undefined) {
                throw new TypeError("production turn resource runner is not bound");
              }
              const projectedActionAuditor = asActionAuditor(actionAuditor);
              if (projectedActionAuditor === undefined) {
                throw new TypeError("production turn action auditor is not bound");
              }
              const createSubagentRunner = (
                agentId: string,
                args: SubagentAdapterArgs,
              ): SubagentSession => {
                // Depth 1 is the cap: a subagent gets its own run shell and its
                // own tool host, but that host reports `isSubagentRunner: true`,
                // so `buildTurnTools` never offers `Task` inside it. That is the
                // whole depth limit — it needs no counter, and it cannot be
                // bypassed by a subagent that tries to dispatch anyway.
                if (scope.isSubagentRunner) {
                  // `SAND_MAX_SUBAGENT_DEPTH` is 1, so any subagent runner is
                  // already past the limit.
                  throw new TypeError(
                    `a subagent cannot spawn another subagent: nesting depth is limited to ${SAND_MAX_SUBAGENT_DEPTH}`,
                  );
                }
                // Concurrency cap. Every live child holds a model stream, a
                // transcript and a box connection, and nothing else in the
                // process bounds the count: the Task tool would otherwise let a
                // single turn open as many runners as it liked. Four is chosen
                // because it is the point where "dispatch a few in parallel"
                // stops being true — beyond it the dispatch is no longer
                // parallel work, it is a fan-out with no owner waiting for it.
                if (liveSubagents.size >= SAND_MAX_ACTIVE_SUBAGENTS) {
                  throw new TypeError(
                    `too many subagents are already running (limit ${SAND_MAX_ACTIVE_SUBAGENTS}): wait for one to finish before dispatching another`,
                  );
                }
                // The child's OWN durable conversation.
                //
                // `runnerOptions.getAgentId` answers `session.id` — the PARENT's —
                // and `runnerOptions.blobStore` / `session.agentStore` are the
                // parent's too. `conversationId: agentId` and
                // `transcriptId: agentId` below could not undo that, because
                // `SandAgentRunner.getConversationId()` prefers `getAgentId` and
                // the settle host took the journal key from the captured
                // session. The child therefore checkpointed into the parent's
                // journal and the parent's next checkpoint was refused with
                // "durable conversation turns moved backwards". Its own store,
                // its own journal key and its own agent id are what keep the two
                // conversations apart.
                if (session.agentStore == null
                  || typeof session.agentStore.getBlobStore !== "function") {
                  throw new TypeError("production Agent blob store is not bound");
                }
                const subagentIdentity = resolveSubagentSettleIdentity(
                  agentId,
                  session.agentStore as unknown as ProductionCheckpointStore,
                );
                const subagentScope: {
                  agentId: string;
                  isSubagentRunner: boolean;
                  subagentType: string | undefined;
                  subagentStore: SubagentConversationStore;
                  ready?: Promise<void>;
                  scopeRunner?: unknown;
                  /** The parent's live direction at the moment of dispatch. */
                  inheritedDirectionEpoch?: number;
                } = {
                  agentId: subagentIdentity.agentId,
                  isSubagentRunner: subagentIdentity.isSubagentRunner,
                  subagentType: args.subagentType,
                  subagentStore: subagentIdentity.conversationStore,
                  ready: subagentIdentity.ready,
                  // Read HERE, at dispatch, and not cached in a closure built
                  // earlier: the child works inside the task its parent is
                  // running right now, so it must share the direction the
                  // parent's current turn opened.
                  ...(turnLocalToolPermission === undefined
                    ? {}
                    : {
                        inheritedDirectionEpoch:
                          turnLocalToolPermission.directionEpoch(session.id),
                      }),
                };
                const child = deps.buildRunner({
                  ...runnerOptions,
                  conversationId: agentId,
                  transcriptId: agentId,
                  // Answers the child's own id, not the captured parent session.
                  getAgentId: () => agentId,
                  getBoxId: () => agentId,
                  isSubagent: true,
                  subagentType: args.subagentType,
                  initialState: {
                    turns: [],
                    summaryArchives: [],
                    turnTimings: [],
                  },
                  productionTurnRunShell: buildProductionTurnRunShellInput(subagentScope),
                });
                // The child's shell was built before the child existed; hand the
                // scope its own runner now so the settle host never falls back
                // to the parent's.
                subagentScope.scopeRunner = child;
                // The parent's `AgentStore2` is deliberately NOT bound here.
                // `setAgentStore` is the child's only fallback for
                // `getAgentConversationStateStructure()`, and binding it made the
                // child's base state the parent's history again.
                bindSessionOwnedRunner(child, { bindParentAgentStore: false });
                ownedRunners.add(child);
                return {
                  run: async (prompt, options) => {
                    liveSubagents.add(agentId);
                    try {
                      const result = await child.run(prompt, options);
                      if (typeof result !== "object" || result == null) {
                        throw new TypeError("production subagent result is not bound");
                      }
                      const text = Reflect.get(result, "text");
                      const aborted = Reflect.get(result, "aborted");
                      if (typeof text !== "string" || typeof aborted !== "boolean") {
                        throw new TypeError("production subagent result is not bound");
                      }
                      return { text, aborted };
                    } finally {
                      liveSubagents.delete(agentId);
                    }
                  },
                  interrupt: reason => {
                    child.interrupt(reason);
                  },
                  getResolvedOutline: () => child.getResolvedOutline(),
                  getObservedToolCallCount: () => child.getObservedToolCallCount(),
                  getActivitySnapshot: () => child.getActivitySnapshot(),
                  getTranscriptPath: () => child.getTranscriptPath(),
                };
              };
              const computerUse = runner.computerUse;
              // Without this projection the turn's resource accessor never
              // registers mcpExecutorResource, so CallMcpTool would exist and
              // fail every call on a missing-resource error. The executor and
              // state executor come from the live MCP service; nothing here is
              // synthesized for a server set that does not exist.
              const mcpForTurn = method(mcp.mcp, "createExecutor") === undefined
                ? undefined
                : {
                    createExecutor: (
                      persistImage: unknown,
                      spillLargeText: unknown,
                      auditIdentity: { readonly agentId: string },
                    ) => method(mcp.mcp, "createExecutor")!(
                      persistImage,
                      spillLargeText,
                      auditIdentity,
                    ),
                    createStateExecutor: () =>
                      method(mcp.mcp, "createStateExecutor")!(),
                    ...(method(mcp.mcp, "resolveNeedsAuthSlot") === undefined
                      ? {}
                      : {
                          resolveNeedsAuthSlot: async (
                            providerIdentifier: string,
                          ) => await method(mcp.mcp, "resolveNeedsAuthSlot")!(
                            providerIdentifier,
                          ),
                        }),
                  };
              return {
                subagentSessions: runner.subagents.sessions,
                createSubagentRunner,
                subagentDispatcher: {
                  isRunning: agentId => runner.subagents.isRunning(agentId),
                  allocateComputerUseWindow: agentId =>
                    computerUse?.allocateWindow(agentId) ?? null,
                  freeComputerUseWindow: agentId => {
                    computerUse?.freeWindow(agentId);
                  },
                  dispatch: input => runner.subagents.dispatchBackgroundSubagent(input),
                },
                ...(mcpForTurn === undefined
                  ? {}
                  : {
                      mcp: {
                        mcpForTurn,
                        persistImage: hooks.persistImage,
                        // The reconstructed host ships no result spiller; the
                        // executor treats an absent spiller as "keep inline".
                        textSpiller: undefined,
                        isSubagentRunner: isSharedRoomTurn,
                        beginObservation: args => {
                          const startedAtMs = Date.now();
                          return (errorClass?: string) => {
                            method(analytics, "trackEvent")?.("sand.mcp.tool_call", {
                              connector: args.connector,
                              ...(args.requestId === undefined
                                ? {}
                                : { request_id: args.requestId }),
                              duration_ms: Date.now() - startedAtMs,
                              ...(errorClass === undefined
                                ? {}
                                : { error_class: errorClass }),
                            });
                          };
                        },
                        boundedConnectorTag,
                        mcpErrorClassOf,
                        takeMcpExecErrorClass,
                        emitConnectorCard: emission => {
                          const connector = emission.connector;
                          if (connector == null) return;
                          hooks.transport.onUpdate({
                            type: "send-message",
                            message: connectorCardEmissionToMessage({
                              connector,
                              serverId: emission.serverId,
                              variant: emission.variant,
                            }),
                            timestampMs: Date.now(),
                            ...(runOptions.ackToken === undefined
                              ? {}
                              : { ackToken: runOptions.ackToken }),
                          });
                        },
                        cancelThisRun: reason => {
                          runner?.interrupt?.(reason.reason);
                        },
                        reportDiagnostic: event => {
                          reportHostDiagnostic({
                            kind: event.kind,
                            errorClass: event.errorClass,
                          });
                        },
                        errorLogTag,
                      },
                    }),
                requestContext: turnRequestContext,
                includeTranscripts: !isSharedRoomTurn,
                autoReviewEnforceEnabled: Object.values(autoReviewModes).includes("enforce"),
                ...(autoReview.autoReviewClassifierExecutor === undefined
                  ? {}
                  : { smartModeClassifierExecutor: autoReview.autoReviewClassifierExecutor }),
                shellStreamExecutor: baseAccessor.get(shellStreamExecutorResource),
                backgroundShellExecutor: baseAccessor.get(backgroundShellExecutorResource),
                autoReviewGate: {
                  assertNoPendingApproval: () => turnAutoReviewGate.assertNoPendingApproval(),
                },
                actionAuditor: projectedActionAuditor,
                agentId: scope.agentId,
              };
            },
            blobStore: getAgentBlobStore(
              session.agentStore as Parameters<typeof getAgentBlobStore>[0],
            ),
            toolHost: lazyToolHost(scope.isSubagentRunner),
            turn,
            staticConfig: {
              modelId: staticModelId,
              agentTokenLimit: 200_000,
              conversationId: scope.agentId,
              isBoxScopedSubagent: false,
              isSubagentRunner: scope.isSubagentRunner,
              isSharedRoomRunner: isSharedRoomTurn,
              sandSendMessageDeliveryOwed: method(experiments, "isSendMessageDeliveryOwedEnabled")?.() ?? false,
              // A subagent is not the user's agent. Handing it the parent's
              // prompt taught it to SendMessage and to manage sibling subagents,
              // which it has neither a channel nor a session map for; the
              // dedicated subagent prompt says what it can actually do.
              systemPromptGenerator: () => scope.isSubagentRunner
                ? buildSandSubagentSystemPrompt({
                    subagentType: scope.subagentType ?? "generalPurpose",
                    readonly: false,
                  })
                : productionSystemPromptAssembly?.getSystemPrompt() ?? DEFAULT_SAND_SYSTEM_PROMPT,
            },
            emitUpdate,
            interactionObservers: {},
            diskPressureReminder: foreverBox.diskPressureReminder,
            ...(productionSystemPromptAssembly === undefined
              ? {}
              : (() => {
                  const profilePromptSnapshotStore = asPromptSnapshotStore(session.db);
                  return profilePromptSnapshotStore === undefined
                    ? {}
                    : { profilePromptSnapshotStore };
                })()),
            emittedConnectorCards: new Set(),
          } satisfies ProductionTurnAgentOwnerInput;
        },
        promptOptions: (_prompt, options) => toGeneratedTurnPromptOptions(options),
        assembleGeneratedTurnAction: productionPromptGlue.assembleGeneratedTurnAction,
        compactionEpoch: () => 0,
        getConversationState: () => getProductionConversationState(scope),
        ...(mcp.mcp != null && typeof mcp.mcp.getTools === "function"
          ? {
              mcp: {
                getTools: (runContext: Context) => mcp.mcp.getTools(runContext),
                refreshAccountConfig: () => mcp.mcp.refreshAccountConfig(),
              },
            }
          : {}),
        createSession: owner => ({
          getModelId: () => owner.runContext.sessions.agent.getModelId(),
          getExecutor: () => createTextExecutor(owner.runContext.toolSession.getExecutor()),
        }),
        context: () => productionContext,
        // The scope decides the journal key, the blob store and the durable
        // checkpoint owner. Handing the child the parent's would put its turn in
        // the parent's journal, which is the defect this whole scope exists to
        // remove.
        createSettleHost: () => {
          const owner = scope.scopeRunner ?? builtRunner;
          if (owner == null) {
            throw new TypeError("production Agent runner is not bound");
          }
          return createProductionTurnSettleHost({
            agentId: scope.agentId,
            isSubagentRunner: scope.isSubagentRunner,
            runner: owner,
            agentStore: scope.subagentStore
              ?? parentSettleScope().agentStore,
          });
        },
        profilePromptSnapshots: () => session.db,
        isSubagentRunner: scope.isSubagentRunner,
        // The live controller, NOT `projectedLocalToolPermission`. Without this
        // pair `SandAgentRunner.localToolPermission` stays `undefined`, so the
        // shell never gets its `beginLocalToolPermissionTurn` hook and
        // `resolveTurnDirectionEpoch` has nothing to read: every turn runs under
        // epoch 0 and no refusal is ever retired. Both production callers of
        // this builder — the parent's own shell below and every `Task`
        // subagent's — read it from here, so neither of them can miss it.
        ...(turnLocalToolPermission === undefined
          ? {}
          : { localToolPermission: turnLocalToolPermission }),
        ...(scope.inheritedDirectionEpoch === undefined
          ? {}
          : { inheritedDirectionEpoch: scope.inheritedDirectionEpoch }),
        subagents: { sessions: new Map() },
        getConversationId: () => scope.agentId,
        // The generation of THIS scope's runner. Reading the parent's here made
        // a subagent's turn report the parent's run generation, so a parent
        // interrupt could supersede a child that was still working.
        runGeneration: () => {
          const owner = scope.scopeRunner ?? builtRunner;
          if (owner == null && scope.isSubagentRunner) {
            throw new TypeError("production subagent runner is not bound");
          }
          return (owner as { currentRunGeneration?: number } | undefined)
            ?.currentRunGeneration ?? 0;
        },
        setActiveTurnRequestSource: () => {},
        beginAutoReviewUserMessageEpoch: () => {},
        setActiveRunInterrupted: () => {},
        setAwaitingUserSelection: () => {},
        isAwaitingUserSelection: () => false,
        emitRunLifecycle: event => hooks.onRunLifecycle?.(event),
        emitUpdate: update => hooks.transport.onUpdate(update),
        ...(hooks.transport.lastReactionApplied === undefined
          ? {}
          : { lastReactionApplied: () => hooks.transport.lastReactionApplied?.() === true }),
        cancelThisRun: () => {},
      });
        return scope.subagentStore === undefined
          ? hostInput
          : {
              ...hostInput,
              // A subagent's durable root is read on a worker thread, so its
              // first turn must not read the base state before that read lands
              // and silently start from an empty conversation.
              createRunInput: async input => {
                await scope.ready;
                return await hostInput.createRunInput(input);
              },
            };
      };

      // The parent's own shell. A subagent's shell is built inside a turn with
      // its own scope, so assigning this after the builder keeps the two from
      // reading each other half-built.
      runnerOptions.productionTurnRunShell = buildProductionTurnRunShellInput({
        agentId: session.id,
        isSubagentRunner: false,
        subagentType: undefined,
      });
    }

    if (deps.createRunStep != null && runnerOptions.productionTurnRunShell === undefined) {
      runnerOptions.runStep = deps.createRunStep({
        session,
        hooks,
        overrides,
        runnerOptions,
        createTurnToolInputs,
      });
    }

    /**
     * Hands a runner the session-owned stores.
     *
     * `bindParentAgentStore: false` is what a subagent needs. `setAgentStore` is
     * the only fallback `SandAgentRunner.getAgentConversationStateStructure()`
     * has, so binding the parent's store made a child's base state — and, with
     * it, the whole checkpoint the child writes — the parent's history.
     */
    function bindSessionOwnedRunner(
      runner: Runner,
      options: { readonly bindParentAgentStore?: boolean } = {},
    ): void {
      if (options.bindParentAgentStore !== false) {
        runner.setAgentStore(session.agentStore, hooks.agentProfileProvider);
      }
      runner.setMemoryStore(session.memory);
      runner.setUserMemory(runnerOptions.userMemory);
      runner.setProjectMemory(runnerOptions.projectMemory);
      runner.setMemorySnapshotStore(session.db);
      runner.setProfilePromptSnapshotStore(session.db);
      runner.setEpisodeProgress(session.db);
      runner.setAutomationStore(session.automations);
      runner.setWorkflowStore(session.workflows);
      runner.setChannelStore(session.channels);
      runner.setMcp(mcp.mcp);
      runner.setMcpManagement(mcp.management);
      runner.setAttachmentIngestor(hooks.ingestAttachment);
      runner.setImagePersister(hooks.persistImage);
      runner.setMediaBytesPersister(hooks.persistMediaBytes);
    }

    const runner = deps.buildRunner(runnerOptions);
    bindSessionOwnedRunner(runner);
    ownedRunners.add(runner);
    builtRunner = runner;
    // Keep the owner-scoped activation anchor stable while retaining the
    // single real buildRunner call needed by post-construction projections.
    // return deps.buildRunner(runnerOptions);
    return runner;
  }

  return {
    createRunner: (session, hooks) => createRunner(session, hooks),
    createGroupMemberRunner: (session, hooks, groupOverrides) =>
      createRunner(session, hooks, {
        ...groupOverrides,
        groupMemberTurn: true
      }),
    canAskLocalToolPermission: agentId =>
      localToolPermissionSurfaces.has(agentId),
    forgetLocalToolPermission: agentId => {
      localToolPermissionSurfaces.get(agentId)?.();
      localToolPermissionSurfaces.delete(agentId);
      method(localToolPermission, "forgetAgent")?.(agentId);
    },
    dispose: async () => {
      for (const runner of ownedRunners) {
        const candidate = runner as {
          interrupt?(reason?: string): unknown;
          dispose?(): void | Promise<void>;
        };
        candidate.interrupt?.("host shutdown");
        await candidate.dispose?.();
      }
      ownedRunners.clear();
      for (const unsubscribe of localToolPermissionSurfaces.values()) {
        unsubscribe();
      }
      localToolPermissionSurfaces.clear();
      await mirrorOffloadPool?.closeAll();
      mirrorOffloadPool = null;
    }
  };
}
