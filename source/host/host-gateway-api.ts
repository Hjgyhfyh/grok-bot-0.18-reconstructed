
import {
  parseCoordinatorAgentThreadRequest,
  parseCoordinatorTranscriptWindowRequest,
} from "../shared/rpc/coordinator.js";
import { errorLogTag } from "../shared/errors.js";

export const HOST_CAPABILITIES = [
  "orderedReplicasV1",
  "sendAcceptanceV1"
] as const;
export const CREATE_AGENT_NONCE_LEDGER_CAP = 64;
export const DISABLE_SEND_ACCEPT_RETURN_ENV = "SAND_DISABLE_SEND_ACCEPT_RETURN";

const SAND_AGENT_PURPOSES = new Set(["disk-saver", "plugin-auth"]);
const TEMPLATE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/**
 * Every profile field a create request may carry, in the order it is forwarded.
 * `instructions` is the agent's own instruction text; it is the one field the
 * renderer never had a control for, which is why creating a "project auditor"
 * or an "idea collector" used to be impossible.
 */
const AGENT_PROFILE_CREATE_FIELDS = [
  "name",
  "description",
  "title",
  "avatarShape",
  "avatarColor",
  "instructions",
] as const;

type DynamicMethod = (...args: any[]) => any;
export type DynamicGatewayApi = Record<string, any>;

export interface HostGatewayDependencies {
  readonly extensions: {
    api(id: string): DynamicGatewayApi;
  };
  readonly hostEvents: {
    emit(event: unknown): unknown;
  };
  readonly rosterBookkeeping?: {
    readonly latestActiveAgentId: string | null;
  };
  decorateForeverBoxStatus(status: any): any;
  getHealth(): { readonly isBusy: boolean };
  kickstartIfPending(agentId: string): Promise<boolean>;
  requestDiskSaverAudit(agentId: string): Promise<boolean>;
  releaseAgentBox(agentId: string): Promise<void>;
  handleDesktopMcpAuthCompletion(completion: unknown): Promise<void>;
  forgetLocalToolPermission(agentId: string): void;
  readonly now?: () => number;
}

function isSandAgentPurpose(value: unknown): value is string {
  return typeof value === "string" && SAND_AGENT_PURPOSES.has(value);
}

function sanitizeTemplateId(value: unknown): string | undefined {
  return typeof value === "string" && TEMPLATE_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function method(api: DynamicGatewayApi, name: string): DynamicMethod {
  const candidate = api[name];
  if (typeof candidate !== "function") {
    throw new Error(`host extension method is unavailable: ${name}`);
  }
  return candidate.bind(api);
}

/**
 * A request field that must arrive as a non-empty string.
 *
 * These commands read their arguments deep inside the extension, past the
 * gateway edge, where a missing string arrives as `undefined` and the first
 * thing the callee does with it is `.trim()`. The host then answered `500` with
 * the raw V8 text — `Cannot read properties of undefined (reading 'trim')` —
 * which names no command, no field and no remedy, and reads like a broken
 * server rather than a malformed request.
 *
 * The check runs before the extension is called, so it only changes the message
 * for a request that was already going to fail: nothing that used to be accepted
 * is refused here, and nothing that used to answer `{accepted:false}` changes
 * its answer.
 */
function requireText(args: unknown, field: string, command: string): string {
  const value = (args as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string") {
    throw new Error(
      `Malformed ${command} request: "${field}" must be a string, and ${typeof value} arrived.`,
    );
  }
  return value;
}

/** A request field that must arrive as a non-empty string. */
function requirePath(args: unknown, field: string, command: string): string {
  const value = (args as unknown as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Malformed ${command} request: "${field}" must be a non-empty string.`,
    );
  }
  return value;
}

/** What arrived instead of a field, in words the caller can act on. */
function arrivalType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (value === "") return "an empty string";
  return typeof value;
}

/**
 * The id list of a batch command, or a refusal that names the field.
 *
 * `deleteAgents` used to answer `200 {transcript:[…]}` for a request that named
 * no agents at all — `{}`, `{"ids":"all"}`, `{"ids":42}` all arrived as an empty
 * list, and an empty list deletes nothing and reports success. Measured on a live
 * box: `POST /api/deleteAgents {}` returned `200` with the current transcript, so
 * a caller that lost its payload could not tell a completed batch from one that
 * never ran. An empty *array* is still a legitimate request for "delete nothing"
 * and still answers `200`; what is refused is a payload that is not a list of ids.
 */
function requireIdList(args: unknown, command: string): string[] {
  const value = (args as Record<string, unknown> | null | undefined)?.ids;
  if (!Array.isArray(value)) {
    throw new Error(
      `Malformed ${command} request: "ids" must be an array, and ${arrivalType(value)} arrived.`,
    );
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(
        `Malformed ${command} request: "ids" must hold non-empty strings, and ${arrivalType(entry)} arrived.`,
      );
    }
  }
  return [...value];
}

/**
 * Restores the shipped gateway method table. Each method delegates to the
 * extension that owned the behavior in the artifact; the host layer retains
 * cross-cutting nonce dedupe, telemetry, cleanup, feature gates, and status
 * decoration.
 */
export function createHostGatewayApi(
  deps: HostGatewayDependencies
): Record<string, DynamicMethod> {
  const manager = deps.extensions.api("transcript");
  const attachments = deps.extensions.api("attachments");
  const automations = deps.extensions.api("automations");
  const managedSetup = deps.extensions.api("managed-setup");
  const settings = deps.extensions.api("settings");
  const localToolPermission = deps.extensions.api("local-tool-permission");
  const telemetry = deps.extensions.api("telemetry");
  const sharing = deps.extensions.api("cross-user-sharing");
  const now = deps.now ?? Date.now;
  const createAgentMintsByNonce = new Map<string, Promise<any>>();

  const markActive = (reason: "user_action" | "app_open") => {
    method(telemetry.analytics, "markActive")(reason);
  };

  /**
   * The profile fields of a create request.
   *
   * `createAgent` used to read `args.name` and `args.description` off the
   * request root and nothing else. The renderer sends `{ profile: {...} }` —
   * the same shape `updateAgent` takes — so both reads were `undefined`, the
   * store fell back to its own defaults, and a caller who passed
   * `{name:"Acceptance Alpha",description:"acceptance run"}` got an agent named
   * `Grok` with an empty description and no error anywhere. A create that
   * discards the name it was given is indistinguishable from a create that was
   * never asked for one, which is why this went unnoticed for as long as it did.
   *
   * Both shapes are accepted: the flat one (root fields) and the nested one
   * (`profile`). The nested object wins only for the fields it actually
   * carries, so a caller may send `{profile:{name}, description}` without
   * losing the description. Anything that is neither object nor absent is
   * ignored rather than passed down as `[object Object]`.
   */
  const createProfileFields = (args: any): Record<string, unknown> => {
    const nested =
      typeof args?.profile === "object" && args.profile !== null
        ? args.profile
        : {};
    const fields: Record<string, unknown> = {};
    for (const key of AGENT_PROFILE_CREATE_FIELDS) {
      const value = nested[key] !== undefined ? nested[key] : args?.[key];
      if (value !== undefined) fields[key] = value;
    }
    return fields;
  };

  const mintAgent = async (args: any) => {
    const fields = createProfileFields(args);
    const result = await method(manager, "createAgent")(
      fields,
      args.origin,
      {
        isIntroductionSuppressed: args.isIntroductionSuppressed ?? false,
        isKickstartRequested: args.isKickstartRequested ?? false,
        ...(isSandAgentPurpose(args.purpose)
          ? { purpose: args.purpose }
          : {})
      }
    );
    markActive("user_action");
    const templateId = sanitizeTemplateId(args.templateId);
    method(telemetry.analytics, "trackEvent")("sand.agent.created", {
      agent_id: result.agent.id,
      origin: args.origin ?? "user",
      ...(templateId === undefined ? {} : { template_id: templateId })
    });
    return result;
  };

  const openAgent = async (
    args: any,
    operation: "switchAgent" | "openAgentWindowed" | "openAgentTail"
  ) => {
    markActive("app_open");
    method(telemetry, "noteSandModelExperimentActive")();
    const wasActive = method(manager, "getActiveAgentId")() === args.id;
    const startedAt = now();
    const result = operation === "switchAgent"
      ? await method(manager, operation)(args.id)
      : await method(manager, operation)(args.id, args.limit);
    const entries = operation === "switchAgent" ? result : result.entries;
    method(telemetry.logs, "reportAgentOpen")({
      conversationId: args.id,
      durationMs: now() - startedAt,
      entryCount: entries.length,
      wasActive
    });
    void deps.kickstartIfPending(args.id);
    return result;
  };

  const markSharingAction = async (name: string, args: any) => {
    markActive("user_action");
    return await method(sharing, name)(args);
  };

  /**
   * Runs the bookkeeping that follows a delete. Each step used to run in a bare
   * loop, so the first failing step abandoned every agent that had not been
   * reached: two targets where one was locked deleted neither handoff, neither
   * schedule, neither box. Failures are collected per agent and returned with the
   * result instead of replacing a completed delete with an error.
   */
  const forgetDeletedAgent = async (
    agentId: string,
  ): Promise<{ agentId: string; error: string }[]> => {
    const failures: { agentId: string; error: string }[] = [];
    const record = (step: string, error: unknown) => {
      failures.push({ agentId, error: `${step}: ${errorLogTag(error)}` });
    };
    try {
      method(deps.extensions.api("session"), "forgetHandoff")(agentId);
    } catch (error) {
      record("forgetHandoff", error);
    }
    try {
      await method(automations, "deleteAgentSchedules")(agentId);
    } catch (error) {
      record("deleteAgentSchedules", error);
    }
    try {
      await deps.releaseAgentBox(agentId);
    } catch (error) {
      record("releaseAgentBox", error);
    }
    try {
      deps.hostEvents.emit({
        kind: "notification-agent-forgotten",
        agentId,
      });
    } catch (error) {
      record("emit", error);
    }
    try {
      deps.forgetLocalToolPermission(agentId);
    } catch (error) {
      record("forgetLocalToolPermission", error);
    }
    return failures;
  };

  const listRoutedMcpTools = async () => {
    const extension = deps.extensions.api("mcp");
    const mcp = extension.mcp;
    const tools = await method(mcp, "listTools")({});
    return tools.map((tool: any) => ({
      name: tool.name,
      providerIdentifier: tool.providerIdentifier,
      toolName: tool.toolName,
      ...(tool.description == null ? {} : { description: tool.description }),
      ...(tool.inputSchema == null ? {} : { inputSchema: typeof tool.inputSchema.toJson === "function" ? tool.inputSchema.toJson() : tool.inputSchema }),
    }));
  };
  const executeRoutedMcpTool = async (args: any) => {
    requireText(args, "name", "executeRoutedMcpTool");
    requireText(args, "toolName", "executeRoutedMcpTool");
    requireText(args, "providerIdentifier", "executeRoutedMcpTool");
    const mcp = deps.extensions.api("mcp").mcp;
    const executor = method(mcp, "createExecutor")(undefined, undefined, { agentId: args.agentId });
    return await method(executor, "execute")({}, {
      name: args.toolName,
      toolName: args.name,
      providerIdentifier: args.providerIdentifier,
      args: args.args,
      toolCallId: args.toolCallId,
    });
  };

  return {
    // This method used to be `() => method(manager, "ensureLoaded")()`, which dropped its
    // argument and answered for whichever session happened to be active. Three different agent
    // ids then produced three byte-identical transcripts, so a probe could not tell one
    // conversation from another and a caller that believed it had asked about agent B was told
    // about agent A. An id names the conversation; only a call with no id at all is a question
    // about the active one.
    getTranscript: (args: any) => {
      const agentId = typeof args?.agentId === "string" && args.agentId.length > 0
        ? args.agentId
        : typeof args?.id === "string" && args.id.length > 0
          ? args.id
          : "";
      return agentId.length === 0
        ? method(manager, "ensureLoaded")()
        : method(manager, "getAgentTranscript")(agentId);
    },
    getAgentTranscript: (args: any) =>
      method(manager, "getAgentTranscript")(args.id),
    getAgentTranscriptPage: (args: any) =>
      method(manager, "getAgentTranscriptPage")(args.id, args),
    getAgentTranscriptWindow: (args: unknown) => {
      const request = parseCoordinatorTranscriptWindowRequest(args);
      if (request == null) throw new Error("Malformed getAgentTranscriptWindow request");
      return method(manager, "getAgentTranscriptWindow")(request.id, args);
    },
    getAgentTranscriptTail: (args: any) =>
      method(manager, "getAgentTranscriptTail")(args.id, args),
    getAgentThread: (args: unknown) => {
      const request = parseCoordinatorAgentThreadRequest(args);
      if (request == null) throw new Error("Malformed getAgentThread request");
      return method(manager, "getAgentThread")(request.id, request.rootId);
    },

    sendPrompt: async (args: any) => {
      requireText(args, "prompt", "sendPrompt");
      const agentId =
        (typeof args.agentId === "string" && args.agentId.length > 0
          ? args.agentId
          : undefined) ??
        method(manager, "getActiveAgentId")() ??
        deps.rosterBookkeeping?.latestActiveAgentId ??
        "unknown";
      method(telemetry, "reportMessageSent")({
        ...args,
        agentId,
        isGroupRoom: method(manager, "listAgentsSync")()
          .find((agent: any) => agent.id === agentId)?.isGroup === true
      });
      await method(manager, "sendPrompt")(args.prompt, {
        agentId: args.agentId,
        directAddressedAcceptance: args.directAddressedAcceptance,
        attachmentPaths: args.attachmentPaths ?? [],
        attachmentNames: args.attachmentNames ?? [],
        richText: args.richText,
        replyToId: args.replyToId,
        clientNonce: args.clientNonce,
        isFork: args.isFork,
        traceparent: args.traceparent,
        enterEpochMs: args.enterEpochMs,
        composedAtMs: args.composedAtMs,
        awaitTurn: process.env[DISABLE_SEND_ACCEPT_RETURN_ENV] === "1"
      });
      return { accepted: true };
    },
    promptAcceptanceStatus: (args: any) =>
      method(manager, "promptAcceptanceStatus")(args),
    respondToWidget: (args: any) => {
      markActive("user_action");
      requireText(args, "value", "respondToWidget");
      method(telemetry.analytics, "trackEvent")("sand.widget.responded", {
        agent_id: args.agentId
      });
      return method(manager, "respondToWidget")(
        args.entryId,
        args.value,
        args.agentId
      );
    },
    resolveAutoReviewApproval: (args: any) => {
      markActive("user_action");
      return method(
        deps.extensions.api("auto-review"),
        "resolveApproval"
      )(args);
    },
    resolveLocalToolPermission: async (args: any) => {
      markActive("user_action");
      await method(localToolPermission, "resolveAsk")(args);
    },
    dismissWidget: (args: any) => {
      markActive("user_action");
      method(telemetry.analytics, "trackEvent")("sand.widget.dismissed", {
        agent_id: args.agentId
      });
      return method(manager, "dismissWidget")(args);
    },
    submitSecret: (args: any) => {
      requireText(args, "value", "submitSecret");
      return method(manager, "submitSecret")(
        args.entryId,
        args.value,
        args.agentId
      );
    },
    reactToMessage: (args: any) => {
      markActive("user_action");
      requireText(args, "emoji", "reactToMessage");
      method(telemetry.analytics, "trackEvent")("sand.reaction.added", {
        agent_id: args.agentId
      });
      return method(manager, "reactToMessage")(
        args.entryId,
        args.emoji,
        args.agentId
      );
    },
    appendConnectorCard: (args: any) =>
      method(manager, "appendConnectorCard")(args),

    listAgents: () => method(manager, "listAgents")(),
    /**
     * How many agents this host stores: the agent directories on disk, which is
     * the same walk the fifty-agent cap refuses on. `listAgents` above is the
     * roster projection and is allowed to answer fewer — it hides a directory
     * with nothing in it, and one whose delete is in flight — so these two
     * commands answer two different questions and are not two readings of one.
     */
    countAgents: () => method(manager, "countAgentsOnDisk")(),
    // An empty query is a real search for everything, so this one field uses the
    // check that allows `""`. Without it a missing query reached the index and
    // answered `500 {"error":"Cannot read properties of undefined (reading
    // 'trim')"}`, which names neither the command nor the field.
    searchAgents: async (args: any) =>
      await method(deps.extensions.api("content-search"), "isEnabled")()
        ? method(manager, "searchAgents")(
            requireText(args, "query", "searchAgents"),
            args.limit,
          )
        : [],
    searchMedia: async (args: any) =>
      await method(deps.extensions.api("content-search"), "isEnabled")()
        ? method(manager, "searchMedia")(
            requireText(args, "query", "searchMedia"),
            args.limit,
          )
        : [],
    createAgent: (args: any) => {
      const nonce = args.clientNonce;
      if (nonce == null || nonce.length === 0) return mintAgent(args);
      const pending = createAgentMintsByNonce.get(nonce);
      if (pending != null) return pending;

      const minted = mintAgent(args);
      createAgentMintsByNonce.set(nonce, minted);
      void minted.catch(() => createAgentMintsByNonce.delete(nonce));
      for (const oldest of createAgentMintsByNonce.keys()) {
        if (createAgentMintsByNonce.size <= CREATE_AGENT_NONCE_LEDGER_CAP) break;
        createAgentMintsByNonce.delete(oldest);
      }
      return minted;
    },
    kickstartAgent: async (args: any) => ({
      isIntroductionInFlight: await deps.kickstartIfPending(args.id)
    }),
    requestDiskSaverAudit: async (args: any) => ({
      isAuditInFlight: await deps.requestDiskSaverAudit(args.id)
    }),
    createGroup: (args: any) => method(manager, "createGroup")({
      name: args.name,
      description: args.description,
      memberIds: args.memberAgentIds
    }),
    setGroupMembers: (args: any) =>
      method(manager, "setGroupMembers")(args.id, args.memberAgentIds),
    updateAgent: (args: any) =>
      method(manager, "updateAgent")(
        requirePath(args, "id", "updateAgent"),
        args.profile,
      ),
    deleteAgent: async (args: any) => {
      // Measured on a live box: `POST /api/deleteAgent {}` answered
      // `500 {"error":"The \"path\" argument must be of type string. Received
      // undefined"}` — the text of a `node:path` call, naming no command, no
      // field and no remedy. The id is the one field every agent command needs,
      // so it is checked here as well as inside the lifecycle, which the
      // coordinator reaches without passing this edge.
      const agentId = requirePath(args, "id", "deleteAgent");
      await method(sharing, "noteAgentDeleted")(agentId).catch(
        () => undefined
      );
      const result = await method(manager, "deleteAgent")(agentId);
      const cleanupFailures = await forgetDeletedAgent(agentId);
      return cleanupFailures.length === 0
        ? result
        : { ...result, cleanupFailures };
    },
    deleteAgents: async (args: any) => {
      const ids = requireIdList(args, "deleteAgents");
      const cleanupFailures: { agentId: string; error: string }[] = [];
      for (const id of ids) {
        try {
          await method(sharing, "noteAgentDeleted")(id);
        } catch (error) {
          cleanupFailures.push({
            agentId: id,
            error: `noteAgentDeleted: ${errorLogTag(error)}`,
          });
        }
      }
      const result = await method(manager, "deleteAgents")(ids);
      for (const id of ids) cleanupFailures.push(...(await forgetDeletedAgent(id)));
      return cleanupFailures.length === 0
        ? result
        : { ...result, cleanupFailures };
    },
    duplicateAgent: (args: any) => method(manager, "cloneAgent")(args.id),
    setAgentUnread: (args: any) =>
      method(manager, "setAgentUnread")(args.id, args.isUnread, args.atMs),
    /**
     * Was `async () => undefined`: the request body `{ id, isEnabled }` was
     * parsed by the protocol layer and then dropped, so the notification switch
     * in the sidebar resolved successfully while changing nothing. It now
     * forwards to the same host call its neighbour uses.
     */
    setAgentNotificationsEnabled: (args: any) =>
      method(manager, "setAgentNotifyOnUpdates")(
        requirePath(args, "id", "setAgentNotificationsEnabled"),
        args.isEnabled,
      ),
    setAgentNotifyOnUpdates: (args: any) =>
      method(manager, "setAgentNotifyOnUpdates")(
        requirePath(args, "id", "setAgentNotifyOnUpdates"),
        args.isEnabled,
      ),
    setAgentHiddenFromSidebar: (args: any) =>
      method(manager, "setAgentHiddenFromSidebar")(
        requirePath(args, "id", "setAgentHiddenFromSidebar"),
        args.isHidden,
      ),
    openAgent: (args: any) => openAgent(args, "switchAgent"),
    openAgentWindowed: (args: any) => openAgent(args, "openAgentWindowed"),
    openAgentTail: (args: any) => openAgent(args, "openAgentTail"),
    setWindowFocused: (args: any) =>
      method(manager, "setWindowFocused")(args.isFocused),

    getAgentMemories: (args: any) =>
      method(manager, "getAgentMemories")(requirePath(args, "id", "getAgentMemories")),
    deleteAgentMemory: (args: any) =>
      method(manager, "deleteAgentMemory")(args.id, args.memoryId),
    clearAgentMemories: (args: any) =>
      method(manager, "clearAgentMemories")(args.id),
    getAgentAutomations: (args: any) =>
      method(manager, "getAgentAutomations")(args.id),
    listAllAutomations: () => method(manager, "listAllAutomations")(),
    isAgentNetworkEnabled: () =>
      method(deps.extensions.api("experiments"), "isAgentNetworkEnabled")(),
    isGlobalSearchEnabled: () =>
      method(deps.extensions.api("content-search"), "isEnabled")(),
    isEgressTunnelAvailable: async () =>
      process.env.SAND_EGRESS_TUNNEL_ENABLED === "1",

    getSharingState: () => method(sharing, "getSharingState")(),
    createRoomFromAgent: (args: any) =>
      markSharingAction("createRoomFromAgent", args),
    createRoomInvite: (args: any) =>
      markSharingAction("createRoomInvite", args),
    joinSharedRoom: (args: any) => markSharingAction("joinSharedRoom", args),
    respondToRoomJoinRequest: (args: any) =>
      markSharingAction("respondToRoomJoinRequest", args),
    createSharedRoom: (args: any) =>
      markSharingAction("createSharedRoom", args),
    addOwnAgentToSharedRoom: (args: any) =>
      markSharingAction("addOwnAgentToSharedRoom", args),
    removeOwnAgentFromSharedRoom: (args: any) =>
      markSharingAction("removeOwnAgentFromSharedRoom", args),
    setSharedRoomTyping: (args: any) =>
      method(sharing, "setSharedRoomTyping")(args),
    leaveSharedRoom: (args: any) => markSharingAction("leaveSharedRoom", args),

    setAgentAutomationEnabled: (args: any) =>
      method(manager, "setAgentAutomationEnabled")(
        args.id,
        args.automationId,
        args.isEnabled
      ),
    createAgentAutomation: async (args: any) => {
      markActive("user_action");
      requirePath(args, "id", "createAgentAutomation");
      if (typeof (args.spec as any)?.trigger !== "object" || args.spec.trigger === null) {
        throw new Error(
          `Malformed createAgentAutomation request: "spec.trigger" must be an object.`,
        );
      }
      const countBefore = (await method(manager, "getAgentAutomations")(
        args.id
      )).length;
      const created = await method(manager, "createAgentAutomation")(
        args.id,
        args.spec
      );
      if (created.length > countBefore) {
        method(telemetry.analytics, "trackEvent")("sand.automation.created", {
          agent_id: args.id,
          trigger_type: args.spec.trigger.type,
          source: "automations_ui"
        });
      }
      return created;
    },
    updateAgentAutomation: (args: any) =>
      method(manager, "updateAgentAutomation")(
        args.id,
        args.automationId,
        args.spec
      ),
    deleteAgentAutomation: (args: any) =>
      method(manager, "deleteAgentAutomation")(args.id, args.automationId),
    runAgentAutomationNow: (args: any) => {
      markActive("user_action");
      return method(manager, "runAgentAutomationNow")(
        args.id,
        args.automationId
      );
    },
    broadcastToAgents: async (args: any) => {
      markActive("user_action");
      const result = await method(manager, "broadcastToAgents")(
        args.targets,
        args.message
      );
      method(telemetry.analytics, "trackEvent")("sand.broadcast.sent", {
        total: result.total,
        scheduled: result.scheduled,
        targets: args.targets === "all" ? "all" : "subset"
      });
      return result;
    },

    getAgentWorkflows: (args: any) =>
      method(manager, "getAgentWorkflows")(args.id),
    createAgentWorkflow: async (args: any) => {
      const isAutomation = args.spec.trigger != null;
      if (isAutomation) markActive("user_action");
      const countBefore = isAutomation
        ? (await method(manager, "getAgentAutomations")(args.id)).length
        : 0;
      const workflows = await method(manager, "createAgentWorkflow")(
        args.id,
        args.spec
      );
      if (isAutomation) {
        const countAfter = (await method(manager, "getAgentAutomations")(
          args.id
        )).length;
        if (countAfter > countBefore) {
          method(telemetry.analytics, "trackEvent")(
            "sand.automation.created",
            {
              agent_id: args.id,
              trigger_type: "cron",
              source: "workflow_ui"
            }
          );
        }
      }
      return workflows;
    },
    updateAgentWorkflow: (args: any) =>
      method(manager, "updateAgentWorkflow")(
        args.id,
        args.workflowId,
        args.spec
      ),
    setAgentWorkflowEnabled: (args: any) =>
      method(manager, "setAgentWorkflowEnabled")(
        args.id,
        args.workflowId,
        args.isEnabled
      ),
    deleteAgentWorkflow: (args: any) =>
      method(manager, "deleteAgentWorkflow")(args.id, args.workflowId),
    runAgentWorkflowNow: (args: any) =>
      method(manager, "runAgentWorkflowNow")(args.id, args.workflowId),
    importAgentWorkflowText: (args: any) =>
      method(manager, "importAgentWorkflowMarkdown")(
        args.id,
        args.markdown,
        args.name
      ),
    importAgentWorkflowUrl: (args: any) =>
      method(manager, "importAgentWorkflowUrl")(args.id, args.url, args.name),
    portAgentLocalSkills: (args: any) =>
      method(manager, "portAgentLocalSkills")(args.id),
    getConversationOutline: (args: any) =>
      method(manager, "getConversationOutline")(
        requirePath(args, "id", "getConversationOutline"),
      ),

    skillsCatalog: () => method(managedSetup, "skillsCatalog")(),
    syncPluginSkills: () =>
      method(deps.extensions.api("mcp"), "syncPluginSkills")(),
    getPluginSyncStatus: () =>
      method(deps.extensions.api("mcp"), "pluginSyncStatus")(),
    getSkillPublishTargets: () =>
      method(deps.extensions.api("mcp").skillPublish, "listTargets")(),
    publishSkill: (args: any) =>
      method(deps.extensions.api("mcp").skillPublish, "publish")(args),
    resyncPublishedSkill: (args: any) =>
      method(deps.extensions.api("mcp").skillPublish, "resync")(args),
    unpublishSkill: (args: any) =>
      method(deps.extensions.api("mcp").skillPublish, "unpublish")(args),

    getAgentChannels: (args: any) =>
      method(automations, "getAgentChannels")(args.id),
    connectChannel: async (args: any) => {
      requirePath(args, "platform", "connectChannel");
      requireText(args, "token", "connectChannel");
      method(manager, "connectChannel")(args.id, args.platform, args.token);
      return method(automations, "getAgentChannels")(args.id);
    },
    disconnectChannel: async (args: any) => {
      method(manager, "disconnectChannel")(args.id, args.platform);
      return method(automations, "getAgentChannels")(args.id);
    },
    refreshChannel: (args: any) =>
      method(automations, "getAgentChannels")(args.id),
    getListenerIntegrations: () =>
      method(automations, "getListenerIntegrations")(),
    getListenerConnectUrl: async (args: any) => ({
      url: await method(automations, "getListenerConnectUrl")(args.platform)
    }),
    getSubagents: (args: any) => method(manager, "getSubagents")(args.id),
    getAsyncTasks: (args: any) => method(manager, "getAsyncTasks")(args.id),
    setAgentAvatarBytes: (args: any) =>
      method(manager, "setAgentAvatarBytes")(
        args.id,
        args.pngBase64 == null
          ? null
          : Uint8Array.from(Buffer.from(args.pngBase64, "base64"))
      ),
    getAgentAvatar: (args: any) =>
      method(manager, "getAgentAvatar")(requirePath(args, "id", "getAgentAvatar")),

    getForeverBoxStatus: async (args: any) =>
      deps.decorateForeverBoxStatus(
        await method(deps.extensions.api("forever-box"), "getStatus")(args)
      ),
    getCloudAgentInfo: (args: any) =>
      method(deps.extensions.api("cloud-agents"), "getInfo")(
        args.bcId,
        args.includeFiles
      ),
    ensureForeverBox: async (args: any) =>
      deps.decorateForeverBoxStatus(
        await method(deps.extensions.api("forever-box"), "ensure")(args)
      ),
    resetForeverBox: async (args: any) =>
      deps.decorateForeverBoxStatus(
        await method(deps.extensions.api("forever-box"), "reset")(args)
      ),
    updateForeverBox: async (args: any) =>
      deps.decorateForeverBoxStatus(
        await method(deps.extensions.api("forever-box"), "update")(args)
      ),
    autoUpdateBoxNow: () =>
      method(deps.extensions.api("forever-box"), "autoUpdateNow")(),
    snapshotBoxStoreNow: (args: any) =>
      method(deps.extensions.api("box-store-sync"), "snapshotBoxStoreNow")(
        args
      ),
    getBoxStoreStatus: () =>
      method(deps.extensions.api("box-store-sync"), "getBoxStoreStatus")(),
    clearBoxStoreNow: () =>
      method(deps.extensions.api("box-store-sync"), "clearBoxStoreNow")(),
    updateHostNow: (args: any) =>
      method(deps.extensions.api("host-upgrade"), "updateHostNow")(args),
    getHostStatus: async () => ({
      ...method(deps.extensions.api("host-upgrade"), "getVersionState")(),
      isBusy: deps.getHealth().isBusy,
      capabilities: HOST_CAPABILITIES
    }),
    setBoxMigrating: async (args: any) => {
      method(deps.extensions.api("forever-box"), "setMigrating")({
        migrating: args.migrating === true
      });
      return { ok: true };
    },
    prepareBoxForRecreate: async () => {
      await method(automations, "suspendWakes")();
      return await method(manager, "quiesceForRecreate")();
    },
    resumeBoxAfterRecreate: async (args: any) => {
      method(automations, "resumeWakes")();
      await method(sharing, "resumeAfterRecreate")();
      return await method(manager, "resumeAfterRecreate")(
        args.agentIds ?? [],
        args.pendingWakes
      );
    },
    handBackForeverBox: (args: any) =>
      method(deps.extensions.api("session"), "endHandoff")(
        args.id,
        args.trigger ?? "button"
      ),

    startTeachRecording: (args: any) =>
      method(deps.extensions.api("teach-recording"), "start")(args),
    stopTeachRecording: (args: any) =>
      method(deps.extensions.api("teach-recording"), "stop")(args),
    getTeachRecordingStatus: () =>
      method(deps.extensions.api("teach-recording"), "getStatus")(),
    getTrays: () => method(deps.extensions.api("trays"), "list")(),
    dismissTray: (args: any) =>
      method(deps.extensions.api("trays"), "dismiss")(args),
    clearTrays: () => method(deps.extensions.api("trays"), "clearAll")(),

    uploadAttachment: (args: any) => method(attachments, "upload")(args),
    readAttachmentImage: (args: any) => method(attachments, "readImage")(args),
    readAttachmentText: (args: any) => method(attachments, "readText")(args),
    readAttachmentChunk: (args: any) => method(attachments, "readChunk")(args),
    getHostSettings: () => method(settings, "getHostSettings")(),
    setHostSettings: (args: any) => {
      const result = method(settings, "setHostSettings")(args);
      if (args.localToolPermission !== undefined) {
        method(localToolPermission, "notePermissionChanged")();
      }
      if (args.webauthnProxyEnabled !== undefined) {
        method(deps.extensions.api("webauthn-proxy"), "applyEnablement")(
          args.webauthnProxyEnabled
        );
      }
      return result;
    },

    refreshMcp: async ({ completion, routedAction, routedArgs }: any) => {
      if (routedAction === "list-tools") return await listRoutedMcpTools();
      if (routedAction === "execute-tool") return await executeRoutedMcpTool(routedArgs);
      if (completion != null) {
        await deps.handleDesktopMcpAuthCompletion(completion);
        return;
      }
      await method(deps.extensions.api("mcp").management, "restart")();
    },
    listRoutedMcpTools,
    executeRoutedMcpTool,
    listBoxMcpServers: async ({ serverIdentifiers }: any) => {
      const servers = await method(
        deps.extensions.api("mcp"),
        "listBoxServers"
      )(serverIdentifiers);
      return {
        servers: servers.map((server: any) => ({
          serverIdentifier: server.serverIdentifier,
          status: server.status,
          ...(server.statusDetail == null
            ? {}
            : { statusDetail: server.statusDetail }),
          toolCount: server.toolCount
        }))
      };
    },
    completeMcpOAuth: async () => undefined,
    requestWebAuthnCeremony: (args: any) =>
      method(deps.extensions.api("webauthn-proxy"), "requestCeremony")(args),
    setBoxSecrets: (args: any) => {
      // `Object.entries(undefined)` inside the secrets store answered `500
      // {"error":"Cannot convert undefined or null to object"}`, which reads as
      // a broken secret store rather than a request that carried no secrets.
      if (typeof args?.secrets !== "object" || args.secrets === null || Array.isArray(args.secrets)) {
        throw new Error(
          `Malformed setBoxSecrets request: "secrets" must be an object, and ${Array.isArray(args?.secrets) ? "an array" : args?.secrets === null ? "null" : typeof args?.secrets} arrived.`,
        );
      }
      return method(deps.extensions.api("secrets"), "set")({ secrets: args.secrets });
    },
    getBoxSecretsStatus: () =>
      method(deps.extensions.api("secrets"), "getStatus")()
  };
}
