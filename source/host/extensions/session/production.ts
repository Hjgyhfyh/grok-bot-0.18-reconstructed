import { dirname, join } from "node:path";
import type { HostExtensionContext } from "../../../internal/host-extensions.js";
import { computerUseExecutorResource } from "../../../packages/agent-exec/computer-use.js";
import type { Executor, RemoteExecManager } from "../../../packages/agent-exec/remote.js";
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.js";
import { AgentStore2, deriveConversationStateFromStructure } from "../../../packages/agent-kv/agent-store.js";
import { createContext } from "../../../packages/context/core.js";
import { loggerKey } from "../../../packages/context/logger.js";
import {
  ComputerUseAction,
  ComputerUseArgs,
  ScreenshotAction,
  type ComputerUseResult,
} from "../../../packages/proto/generated/agent/v1/computer_use_tool_pb.js";
import { AgentWorkerPool } from "../../agent-isolation/agent-worker-pool.js";
import { WorkerBlobStore } from "../../agent-isolation/worker-blob-store.js";
import { deriveOutlineFromConversationState, type ConversationState } from "../../runner/conversation-outline.js";
import { getSandAgentsRootDir } from "../../storage/agent-paths.js";
import { getSandAgentDbWriteGeneration, liveDbHandleCount } from "../../storage/store-db.js";
import { agentMemoryHasContent } from "../memory/memory-service.js";
import { SandAgentSessionStore, type ConversationStatePort } from "./agent-session.js";
import type { SandAgentProfile } from "../../agents/agent-profile.js";
import { ensureAgentDbDirectory } from "./agent-db.js";
import type { BoxHandoffDeps } from "./box-handoff-service.js";
import { scheduleConversationSizeMaintenance, type ConversationGcVerdict } from "./conversation-size-limits.js";
import type { SessionExtensionContext } from "./extension.js";
import {
  clearStaleCheckpointRootsOnce,
  recoverConversationIfRootMissing,
  repairHiddenTranscriptEntriesOnce,
  retireLegacyStoreBlobsOnce,
  type MaintenanceDb,
  type MaintenanceHost,
  type MaintenanceStore,
} from "./session-maintenance.js";
import { SandSessionConversationState } from "./session-conversation-state.js";
import { SandSessionMaterialization, type MaterializedSession } from "./session-materialization.js";
import {
  CONVERSATION_BLOBS_FILENAME,
  SAND_CONVERSATION_ROOT_SLOT_ID,
  getAgentDbPath,
  getSandTranscriptsDir,
  STORE_FILENAME,
} from "./session-paths.js";

interface SessionProductionDeps {
  "forever-box": {
    box: {
      ensureReady(context: ReturnType<typeof createContext>, agentId: string): Promise<{
        remoteAccessor?: unknown;
      }>;
    };
  };
  settings: SessionExtensionContext["deps"]["settings"];
  experiments: SessionExtensionContext["deps"]["experiments"];
  telemetry: {
    logs: {
      reportBoxHelp(event: Record<string, unknown>): void;
      reportSessionDiagnostic?(event: Record<string, unknown>): void;
    };
    analytics: {
      trackEvent(name: string, properties: Record<string, unknown>): void;
    };
  };
}

interface SessionProductionHost {
  events: {
    emit(topic: string, payload: unknown, options?: { failureMode?: "reject" }): Promise<void>;
  };
}

type ProductionContext = HostExtensionContext<SessionProductionHost> & {
  readonly deps: SessionProductionDeps;
};

type ProductionAgentStore = AgentStore2<ReturnType<typeof createContext>>;

/**
 * The production host mints agents, so the production host is what creates agent
 * directories.
 *
 * `SandAgentDb` no longer creates one as a side effect of being opened: a late
 * read of a deleted agent's `store.db` used to run `mkdirSync` and hand the
 * caller a fresh empty database inside a brand new directory, which then held a
 * slot of the fifty-agent cap that `listAgents` never showed. Creating is an
 * explicit act now, and minting an agent is the one place that means it.
 *
 * Требует владельца `source/host/extensions/session/session-materialization.ts`:
 * put this same one line in `SandSessionMaterialization.materializeSession`
 * (`ensureAgentDbDirectory(getAgentDbPath(this.host.rootDir, agentId))` before
 * `new SandAgentDb(dbPath)`) so every host that builds a materialization gets
 * the guarantee without this wrapper. Until then the wrapper is the production
 * host's own copy of the line, and the tests below exercise the contract rather
 * than this class.
 */
class ExplicitAgentDirectoryMaterialization extends SandSessionMaterialization {
  override async materializeSession(
    agentId: string,
    profile?: Partial<SandAgentProfile>,
    origin?: "user" | "dev",
    purpose?: string,
  ): Promise<MaterializedSession> {
    ensureAgentDbDirectory(getAgentDbPath(this.host.rootDir, agentId));
    return await super.materializeSession(agentId, profile, origin, purpose);
  }
}

function asMaintenanceStore(store: ProductionAgentStore): MaintenanceStore {
  return store as unknown as MaintenanceStore;
}

/**
 * True while this process still holds a `store.db` handle for the agent, which
 * is true for every agent with an open session and false for a directory that
 * only exists on disk.
 *
 * The path is joined by hand on purpose: the reclaim pass walks every directory
 * under the agents root, including ones whose name is not a valid agent id, and
 * a directory with a junk name has to come back as a reclaim rather than as a
 * thrown `SandInvalidAgentIdError`.
 */
function hostHoldsAgentStore(
  store: SandAgentSessionStore,
  agentId: string,
): boolean {
  return (
    liveDbHandleCount(join(store.rootDir, agentId, STORE_FILENAME)) > 0
  );
}

async function runMaintenance(
  session: MaterializedSession,
  materialization: SandSessionMaterialization,
  conversationState: SandSessionConversationState,
  context: ReturnType<typeof createContext>,
  rootDir: string,
  report: ((event: Record<string, unknown>) => void) | undefined,
): Promise<void> {
  const workerPool = materialization.requireWorkerPool();
  const host: MaintenanceHost = {
    rootDir,
    ctx: context,
    liveHandleCount: liveDbHandleCount,
    writeGeneration: getSandAgentDbWriteGeneration,
    requireWorkerPool: () => ({
      clearStaleCheckpointRoots: (agentId, blobDbPath, rootHex, dbPath) =>
        workerPool.clearStaleCheckpointRoots(agentId, blobDbPath, rootHex, dbPath),
      findLatestRootBlobId: async args => await workerPool.findLatestRootBlobId(args) ?? null,
      verifyLegacyBlobRetirement: async args =>
        await workerPool.verifyLegacyBlobRetirement(args) as {
          isRetirable: boolean;
          reason?: string;
          legacyRows?: number;
          legacyBytes?: number;
        },
    }),
    resolveConversationState: (structure, blobStore) =>
      conversationState.resolveConversationState(
        structure as Parameters<typeof conversationState.resolveConversationState>[0],
        blobStore as Parameters<typeof conversationState.resolveConversationState>[1],
      ) as Promise<{ turns: readonly { items: readonly never[] }[] } | null>,
    deriveOutline: state => deriveOutlineFromConversationState(state as ConversationState) as unknown as ReturnType<NonNullable<MaintenanceHost["deriveOutline"]>>,
    ...(report === undefined ? {} : { report }),
  };
  const db = session.db as unknown as MaintenanceDb;
  const store = asMaintenanceStore(session.agentStore as ProductionAgentStore);
  const root = session.db.get("latestRootBlobId");
  if (root.length === 0) {
    await recoverConversationIfRootMissing(host, session.dbPath, db, store);
  }
  await repairHiddenTranscriptEntriesOnce(host, session.dbPath, db, store);
  await clearStaleCheckpointRootsOnce(host, session.dbPath, db, store);
  await retireLegacyStoreBlobsOnce(host, session.dbPath, db, store);
  scheduleConversationSizeMaintenance(
    {
      requireWorkerPool: () => ({
        collectConversationGarbage: async args =>
          await workerPool.collectConversationGarbage(args) as ConversationGcVerdict,
      }),
    },
    session.dbPath,
    session.db,
  );
}

async function grabHandoffScreenshot(
  box: SessionProductionDeps["forever-box"]["box"],
  context: ReturnType<typeof createContext>,
  agentId: string,
): Promise<string | null> {
  const connection = await box.ensureReady(context, agentId);
  const accessor = connection.remoteAccessor as ResourceAccessor<RemoteExecManager> | undefined;
  if (accessor == null) return null;
  const computerUse = accessor.get(computerUseExecutorResource) as Executor<ComputerUseArgs, ComputerUseResult>;
  const result = await computerUse.execute(
    context,
    new ComputerUseArgs({
      actions: [
        new ComputerUseAction({
          action: { case: "screenshot", value: new ScreenshotAction({}) },
        }),
      ],
    }),
  );
  if (result.result.case !== "success") return null;
  return result.result.value.screenshot ?? null;
}

/** Artifact construction at host-main.cjs:633435-633496; facade helpers at 632027-632660. */
export function createSessionProductionExtras(
  context: ProductionContext,
): Omit<SessionExtensionContext, "deps" | "onStop"> {
  const rootDir = getSandAgentsRootDir();
  const requestContext = createContext().with(loggerKey, { log: () => {} });
  return {
    rootDir,
    getTranscriptsDir: getSandTranscriptsDir,
    createStore(resolveUserTimeZone) {
      return new SandAgentSessionStore(rootDir, resolveUserTimeZone, {
        createMaterialization(store) {
          let materialization: SandSessionMaterialization;
          materialization = new ExplicitAgentDirectoryMaterialization({
            ctx: requestContext,
            rootDir: store.rootDir,
            createBlobWorkerPool: () => new AgentWorkerPool(),
            createAgentStore: ({ pool, agentId, dbPath, db }) => new AgentStore2(
              new WorkerBlobStore(
                pool,
                agentId,
                join(dirname(dbPath), CONVERSATION_BLOBS_FILENAME),
                dbPath,
              ),
              db,
              { fixedRootBlobId: SAND_CONVERSATION_ROOT_SLOT_ID },
            ),
            createMemoryStore: agentDir => store.createMemoryStore(agentDir),
            resolveUserTimeZone: () => store.getUserTimeZone(),
            agentExists: agentId => store.agentExists(agentId),
            getAgentDir: agentId => store.getAgentDir(agentId),
            readActiveAgentId: () => store.readActiveAgentId(),
            // The reclaim pass asks two questions about a directory it found on
            // disk, and both used to be answered "no" no matter what:
            //
            //   - `isAgentInUse`: is this agent one the host still holds? It was
            //     never supplied, so `isPrunedPlaceholder` read `undefined` and
            //     treated a live session as garbage. A freshly created agent
            //     with no transcript and no name is exactly what
            //     `buildSummary({ includeBlank: false })` returns `null` for, so
            //     the next cap check would have deleted an agent the user had
            //     just made and was looking at. An open session holds a
            //     `node:sqlite` handle to that agent's `store.db`; the handle
            //     registry is the honest answer to "the host still holds this".
            //
            //   - `hasMemory`: does the memory extension hold facts for this
            //     directory? Also never supplied, so a blank agent with memory
            //     was judged a placeholder. The memory extension owns the
            //     answer; ask it instead of guessing.
            //
            // The hook this replaced, `isVisibleAgent`, asked a third question —
            // "would the roster show this agent?" — which `isPrunedPlaceholder`
            // already answers itself through `buildSummary`, and which nothing
            // ever called. `summarizeAgentById` summarizes with
            // `includeBlank: true`, so it returns a record for an empty agent
            // and the answer was always "visible". A hook that answers a
            // question nobody asks cannot keep a directory alive.
            isAgentInUse: agentId => hostHoldsAgentStore(store, agentId),
            hasMemory: agentDir => agentMemoryHasContent(agentDir),
            runMaintenance: session => {
              const conversationState = store.conversationState;
              if (!(conversationState instanceof SandSessionConversationState)) {
                throw new Error("Session conversation state is not initialized");
              }
              return runMaintenance(
                session,
                materialization,
                conversationState,
                requestContext,
                rootDir,
                context.deps.telemetry.logs.reportSessionDiagnostic,
              );
            },
            report: event => context.deps.telemetry.logs.reportSessionDiagnostic?.(event),
          });
          return materialization;
        },
        createConversationState(store) {
          return new SandSessionConversationState({
            rootDir: store.rootDir,
            ctx: requestContext,
            openSession: agentId => store.openSession(agentId) as never,
            deriveState: (structure, blobStore) => deriveConversationStateFromStructure(
              requestContext,
              structure as never,
              blobStore as never,
            ),
            deriveOutline: state => deriveOutlineFromConversationState(state as ConversationState),
          }) as unknown as ConversationStatePort;
        },
      });
    },
    createHandoffDeps(): BoxHandoffDeps {
      const box = context.deps["forever-box"].box;
      return {
        grabScreenshot: agentId => grabHandoffScreenshot(box, requestContext, agentId),
        onStarted: event => {
          void context.host.events.emit("session.box-handoff-started", event);
        },
        onEnded: event => context.host.events.emit(
          "session.box-handoff-ended",
          event,
          { failureMode: "reject" },
        ),
        onStatusChanged: agentId => {
          void context.host.events.emit("session.box-handoff-status-changed", { agentId });
        },
        telemetry: {
          reportBoxHelp: event => context.deps.telemetry.logs.reportBoxHelp(event),
          trackEvent: (name, properties) => context.deps.telemetry.analytics.trackEvent(name, properties),
        },
      };
    },
  };
}
