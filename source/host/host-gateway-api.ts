
import {
  parseCoordinatorAgentThreadRequest,
  parseCoordinatorTranscriptWindowRequest,
} from "../shared/rpc/coordinator.js";
import { errorLogTag } from "../shared/errors.js";
import { SandGatewayRequestError } from "./gateway-server.js";

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
 * A refusal the gateway raises for itself, before any extension is reached.
 *
 * `SandGatewayRequestError` is the class `statusForCommandError` answers `400`:
 * the request arrived, the host read it, and the host is declining it. That is
 * one fact, and every refusal below is an instance of it. Measured on a live
 * box, all of these used to answer `500` while naming the command and the field
 * correctly — the message was right and the status said the server broke:
 *
 *   `POST /api/deleteAgent {}`            500  "Malformed deleteAgent request: \"id\" must be a non-empty string."
 *   `POST /api/searchAgents {}`           500  "Malformed searchAgents request: \"query\" must be a string, and undefined arrived."
 *   `POST /api/connectChannel {}`         500  "Malformed connectChannel request: \"platform\" must be a non-empty string."
 *   `POST /api/setBoxSecrets {}`          500  "Malformed setBoxSecrets request: \"secrets\" must be an object, and undefined arrived."
 *   `POST /api/executeRoutedMcpTool {}`   500  "Malformed executeRoutedMcpTool request: \"name\" must be a string, and undefined arrived."
 *   `POST /api/deleteAgents {"ids":"x"}`  500  "Malformed deleteAgents request: \"ids\" must be an array, and string arrived."
 *   `POST /api/deleteAgent {"id":`        400  "Malformed deleteAgent request: the body is not valid JSON."
 *
 * The last line is the same mistake on the same endpoint, already answered with
 * a status that blames the caller. The checks existed; the status did not.
 */
function malformed(command: string, detail: string): SandGatewayRequestError {
  return new SandGatewayRequestError(`Malformed ${command} request: ${detail}`);
}

/**
 * A request field that must arrive as a string.
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
    throw malformed(
      command,
      `"${field}" must be a string, and ${arrivalType(value)} arrived.`,
    );
  }
  return value;
}

/** A request field that must arrive as a non-empty string. */
function requirePath(args: unknown, field: string, command: string): string {
  const value = (args as unknown as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw malformed(command, `"${field}" must be a non-empty string.`);
  }
  return value;
}

/**
 * A request field that must arrive as a plain object, not an array.
 *
 * `createAgentWorkflow` and `updateAgentWorkflow` read `spec.trigger` and
 * `spec.name` on their first line. Measured on a live box,
 * `POST /api/createAgentWorkflow {"id":"…"}` answered
 * `500 {"error":"Cannot read properties of undefined (reading 'trigger')"}` and
 * `POST /api/updateAgentWorkflow {"id":"…"}` answered the same for `name` — the
 * shape of the payload was the fault and the answer never said so.
 */
function requireObject(args: unknown, field: string, command: string): Record<string, unknown> {
  const value = (args as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed(command, `"${field}" must be an object, and ${arrivalType(value)} arrived.`);
  }
  return value as Record<string, unknown>;
}

/**
 * A request field that may be absent, but must be a finite number when present.
 *
 * `getAgentTranscriptWindow` parses `beforeSeq` and `limit` in
 * `parseCoordinatorTranscriptWindowRequest` and refuses the whole request when
 * either one is a non-number, so a missing field is what that parser is for. The
 * message it produced — `Malformed getAgentTranscriptWindow request` — named
 * neither field, and a caller with three of them in hand cannot tell which one
 * to fix.
 */
function requireOptionalNumber(args: unknown, field: string, command: string): void {
  const value = (args as Record<string, unknown> | null | undefined)?.[field];
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw malformed(command, `"${field}" must be a finite number when present, and ${arrivalType(value)} arrived.`);
  }
}

/**
 * Every field a command cannot answer without, named in one refusal.
 *
 * A first-field-wins message is worse on two counts. A caller holding `{}` for a
 * three-field command is told one name and has to guess the rest, so the cost of
 * a wrong guess is another round trip; and the order the checks happen to be
 * written in quietly becomes a contract that no caller should depend on. One
 * sentence naming all of them is one round trip, and it is the same sentence
 * whichever field happens to be checked first.
 *
 * `allowEmpty` keeps a field that may legitimately be `""` — a channel token is
 * read for emptiness later, while a platform name is not.
 */
function requireFields(
  args: unknown,
  command: string,
  fields: readonly { field: string; allowEmpty?: boolean }[],
): void {
  const record = args as Record<string, unknown> | null | undefined;
  const missing = fields.filter(
    ({ field, allowEmpty }) =>
      typeof record?.[field] !== "string" || (!allowEmpty && record[field] === ""),
  );
  if (missing.length === 0) return;
  const names = missing.map(({ field }) => `"${field}"`);
  const list = names.length === 2 ? `${names[0]} and ${names[1]}` : names.join(", ");
  const strict = missing.some(({ allowEmpty }) => allowEmpty !== true);
  const kind = `${strict ? "non-empty " : ""}string`;
  throw malformed(
    command,
    `${list} must ${names.length === 1 ? "be a" : "each be a"} ${kind}.`,
  );
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
    throw malformed(command, `"ids" must be an array, and ${arrivalType(value)} arrived.`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw malformed(
        command,
        `"ids" must hold non-empty strings, and ${arrivalType(entry)} arrived.`,
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
    requireFields(args, "executeRoutedMcpTool", [
      { field: "name" },
      { field: "toolName" },
      { field: "providerIdentifier" },
    ]);
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
      method(manager, "getAgentTranscript")(
        requirePath(args, "id", "getAgentTranscript"),
      ),
    getAgentTranscriptPage: (args: any) =>
      method(manager, "getAgentTranscriptPage")(
        requirePath(args, "id", "getAgentTranscriptPage"), args,
      ),
    /**
     * The two parsers below already refused a request they could not read, but
     * both refusals named neither field: `POST /api/getAgentTranscriptWindow {}`
     * and `POST /api/getAgentThread {}` answered `500 {"error":"Malformed
     * getAgentTranscriptWindow request"}` — a caller holding three candidate
     * fields cannot tell which one to fix. The fields are checked here, by name,
     * before the parser runs; the parser stays the authority on the answer shape.
     *
     * `getAgentTranscriptPage` and `getAgentTranscriptTail` are the other half
     * of this defect and they were quieter than any other command measured here:
     * they never threw at all. `POST /api/getAgentTranscriptPage {}` and
     * `POST /api/getAgentTranscriptTail {"limit":1}` answered `200
     * {"entries":[]}` — "this conversation is empty", for a request that named
     * no conversation. A renderer that lost its agent id renders an empty chat
     * and looks like a data loss. `POST /api/openAgentWindowed {}` did the same
     * and additionally reported a successful switch to nothing.
     */
    getAgentTranscriptWindow: (args: any) => {
      requirePath(args, "id", "getAgentTranscriptWindow");
      requireOptionalNumber(args, "beforeSeq", "getAgentTranscriptWindow");
      requireOptionalNumber(args, "limit", "getAgentTranscriptWindow");
      const request = parseCoordinatorTranscriptWindowRequest(args);
      if (request == null) throw malformed("getAgentTranscriptWindow", '"id", "beforeSeq" and "limit" did not read as a window request.');
      return method(manager, "getAgentTranscriptWindow")(request.id, args);
    },
    getAgentTranscriptTail: (args: any) =>
      method(manager, "getAgentTranscriptTail")(
        requirePath(args, "id", "getAgentTranscriptTail"), args,
      ),
    getAgentThread: (args: any) => {
      requireFields(args, "getAgentThread", [{ field: "id" }, { field: "rootId" }]);
      const request = parseCoordinatorAgentThreadRequest(args);
      if (request == null) throw malformed("getAgentThread", '"id" and "rootId" did not read as a thread request.');
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
    // Both widget answers below were reached with a request that named no agent and
    // no widget entry. `POST /api/resolveAutoReviewApproval {}` answered
    // `500 {"error":"Invalid Sand agent id: undefined"}` — the id check one layer
    // down naming the value it was handed. `POST /api/resolveLocalToolPermission
    // {}` answered `500 {"error":"Unknown local-tool permission resolution."}`,
    // which names neither the field (`resolution`) nor the command, and reads as
    // "you answered a question that was never asked" rather than "you left the
    // answer out".
    resolveAutoReviewApproval: (args: any) => {
      markActive("user_action");
      requirePath(args, "agentId", "resolveAutoReviewApproval");
      return method(
        deps.extensions.api("auto-review"),
        "resolveApproval"
      )(args);
    },
    resolveLocalToolPermission: async (args: any) => {
      markActive("user_action");
      requireText(args, "resolution", "resolveLocalToolPermission");
      await method(localToolPermission, "resolveAsk")(args);
    },
    /**
     * The question an agent is blocked on, for a caller that never saw the card.
     *
     * `resolveLocalToolPermission` above is the only half of the round trip that
     * existed. The other half — `getPendingRequestForAgent` on the controller —
     * had no caller in the repository outside a test, and no gateway command read
     * it. The card is a push: `bindLocalPermissionSurface` in
     * `host-runner-composition.ts` subscribes to the controller and emits the ask
     * as a `local-tool-permission` transcript entry, so the question exists for the
     * user only from the moment the renderer happens to be listening for that one
     * agent. A window closed before that emit, or an agent whose conversation is
     * not the open one, leaves the tool call blocked inside `authorize` behind a
     * referenced ten-minute timer that holds the event loop open. Nothing on
     * screen says a question is waiting, and when the ask expires on its own the
     * agent is told the user never answered — which is true and is not what
     * happened.
     *
     * The answer is a LIST, not a single object and not a `404`. At most one ask
     * per agent is open at a time in practice, but the shape has to survive an
     * agent that opens a second one while this caller was mid-poll, and an empty
     * list has to read as "nobody is waiting on you" — the normal state of every
     * agent, polled on a timer — rather than as a missing endpoint. `requirePath`
     * names `agentId` in the refusal for the same reason the neighbours above do:
     * a caller holding `{}` is told which field to fix instead of being handed a
     * V8 sentence about a `Map`.
     *
     * It is a pull. It answers whoever asks, at the moment they ask. It does not
     * make the user look at the question; see `tests/list-pending-local-tool-permissions.test.mjs`
     * for what is still missing on the interface side of this.
     */
    listPendingLocalToolPermissions: (args: any) => {
      markActive("user_action");
      const ask = method(localToolPermission, "getPendingRequestForAgent")(
        requirePath(args, "agentId", "listPendingLocalToolPermissions"),
      );
      return ask == null ? [] : [ask];
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
    /**
     * `kickstartAgent` and `requestDiskSaverAudit` take no path through a store,
     * so a missing id used to be invisible rather than fatal. Measured on a live
     * box, `POST /api/kickstartAgent {}`, `{"id":42}` and `{"id":"1111…"}` — a
     * request that named nothing, one that named a number, and one that named an
     * agent nobody created — all answered the same
     * `200 {"isIntroductionInFlight":false}`. That answer also means "the
     * introduction really is running", so a caller whose id was lost reads the
     * one reply that tells it to carry on.
     */
    kickstartAgent: async (args: any) => ({
      isIntroductionInFlight: await deps.kickstartIfPending(requirePath(args, "id", "kickstartAgent"))
    }),
    requestDiskSaverAudit: async (args: any) => ({
      isAuditInFlight: await deps.requestDiskSaverAudit(requirePath(args, "id", "requestDiskSaverAudit"))
    }),
    createGroup: (args: any) => method(manager, "createGroup")({
      name: requireText(args, "name", "createGroup"),
      description: args.description,
      memberIds: args.memberAgentIds
    }),
    // `setGroupMembers` read its id straight off the request, so the agent root
    // was joined onto `undefined` and the host answered `500 {"error":"The
    // \"path\" argument must be of type string. Received undefined"}` — the text
    // of a `node:path` call, naming no command, no field and no remedy. Measured
    // on a live box with `POST /api/setGroupMembers {}`.
    setGroupMembers: (args: any) =>
      method(manager, "setGroupMembers")(
        requirePath(args, "id", "setGroupMembers"), args.memberAgentIds),
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
    // `cloneAgent(undefined)` reached the lifecycle as "that agent no longer
    // exists" — a sentence about an agent, for a request that named none. Measured
    // on a live box: `POST /api/duplicateAgent {}` answered
    // `500 {"error":"That agent no longer exists."}`.
    duplicateAgent: (args: any) =>
      method(manager, "cloneAgent")(requirePath(args, "id", "duplicateAgent")),
    // Same shape, same fix: `POST /api/setAgentUnread {}` answered
    // `500 {"error":"Invalid Sand agent id: undefined"}` — the id check two
    // layers down naming the value it was handed rather than the field the
    // caller left out.
    setAgentUnread: (args: any) =>
      method(manager, "setAgentUnread")(
        requirePath(args, "id", "setAgentUnread"), args.isUnread, args.atMs),
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
    // `openAgent` is allowed to carry no id: switching to the active agent is a
    // real request. The two windowed forms are not — they answer about one
    // conversation, and `POST /api/openAgentWindowed {}` answered
    // `200 {"entries":[]}` while reporting a successful switch, which is
    // indistinguishable from a conversation that has no messages.
    openAgent: (args: any) => openAgent(args, "switchAgent"),
    openAgentWindowed: (args: any) => {
      requirePath(args, "id", "openAgentWindowed");
      return openAgent(args, "openAgentWindowed");
    },
    openAgentTail: (args: any) => {
      requirePath(args, "id", "openAgentTail");
      return openAgent(args, "openAgentTail");
    },
    setWindowFocused: (args: any) =>
      method(manager, "setWindowFocused")(args.isFocused),

    getAgentMemories: (args: any) =>
      method(manager, "getAgentMemories")(requirePath(args, "id", "getAgentMemories")),
    // `deleteAgentMemory {}` answered `500 {"error":"The \"path\" argument must be of
    // type string. Received undefined"}` — the id was joined onto the agent root
    // by a `node:path` call that was handed `undefined`.
    deleteAgentMemory: (args: any) =>
      method(manager, "deleteAgentMemory")(
        requirePath(args, "id", "deleteAgentMemory"), args.memoryId),
    clearAgentMemories: (args: any) =>
      method(manager, "clearAgentMemories")(
        requirePath(args, "id", "clearAgentMemories")),
    getAgentAutomations: (args: any) =>
      method(manager, "getAgentAutomations")(
        requirePath(args, "id", "getAgentAutomations")),
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

    // `setAgentAutomationEnabled {"id":"1111…"}` answered `200 []` — an empty list
    // that reads as "this agent has no automations", for a request that named no
    // automation to switch. Every sibling below needs the same two fields.
    setAgentAutomationEnabled: (args: any) =>
      method(manager, "setAgentAutomationEnabled")(
        requirePath(args, "id", "setAgentAutomationEnabled"),
        requirePath(args, "automationId", "setAgentAutomationEnabled"),
        args.isEnabled
      ),
    createAgentAutomation: async (args: any) => {
      markActive("user_action");
      requirePath(args, "id", "createAgentAutomation");
      if (typeof (args.spec as any)?.trigger !== "object" || args.spec.trigger === null) {
        throw malformed("createAgentAutomation", '"spec.trigger" must be an object.');
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
    // `updateAgentAutomation {"id":"…","automationId":"probe","spec":{}}` answered
    // `500 {"error":"Cannot read properties of undefined (reading 'replace')"}` —
    // the automation runtime rewriting a trigger field that `spec:{}` does not
    // carry. The `spec` shape is checked before the runtime is entered, so the
    // caller is told which field to fix instead of being handed a V8 sentence.
    updateAgentAutomation: (args: any) =>
      method(manager, "updateAgentAutomation")(
        requirePath(args, "id", "updateAgentAutomation"),
        requirePath(args, "automationId", "updateAgentAutomation"),
        requireObject(args, "spec", "updateAgentAutomation"),
      ),
    deleteAgentAutomation: (args: any) =>
      method(manager, "deleteAgentAutomation")(
        requirePath(args, "id", "deleteAgentAutomation"),
        requirePath(args, "automationId", "deleteAgentAutomation"),
      ),
    runAgentAutomationNow: (args: any) => {
      markActive("user_action");
      return method(manager, "runAgentAutomationNow")(
        requirePath(args, "id", "runAgentAutomationNow"),
        requirePath(args, "automationId", "runAgentAutomationNow"),
      );
    },
    /**
     * `POST /api/broadcastToAgents {}` answered
     * `500 {"error":"Cannot read properties of undefined (reading 'trim')"}` — the
     * message clamp, one layer down, tripping on a `message` that never arrived.
     * The other half of the same request was quieter: `targets` that is not
     * `"all"` becomes an empty id set, so `{"targets":[],"message":"x"}` is a
     * real request to broadcast to nobody, and stays one.
     */
    broadcastToAgents: async (args: any) => {
      markActive("user_action");
      if (args.targets !== "all" && !Array.isArray(args.targets)) {
        throw malformed("broadcastToAgents", `"targets" must be "all" or an array of agent ids, and ${arrivalType(args.targets)} arrived.`);
      }
      requireText(args, "message", "broadcastToAgents");
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
      method(manager, "getAgentWorkflows")(
        requirePath(args, "id", "getAgentWorkflows")),
    // `createAgentWorkflow {"id":"1111…"}` answered
    // `500 {"error":"Cannot read properties of undefined (reading 'trigger')"}` and
    // `updateAgentWorkflow {"id":"1111…"}` answered the same for `name`: the first
    // line of each, on a `spec` that never arrived.
    createAgentWorkflow: async (args: any) => {
      requirePath(args, "id", "createAgentWorkflow");
      const spec = requireObject(args, "spec", "createAgentWorkflow");
      const isAutomation = (spec as any).trigger != null;
      if (isAutomation) markActive("user_action");
      const countBefore = isAutomation
        ? (await method(manager, "getAgentAutomations")(args.id)).length
        : 0;
      const workflows = await method(manager, "createAgentWorkflow")(
        args.id,
        spec
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
        requirePath(args, "id", "updateAgentWorkflow"),
        requirePath(args, "workflowId", "updateAgentWorkflow"),
        requireObject(args, "spec", "updateAgentWorkflow"),
      ),
    setAgentWorkflowEnabled: (args: any) =>
      method(manager, "setAgentWorkflowEnabled")(
        requirePath(args, "id", "setAgentWorkflowEnabled"),
        requirePath(args, "workflowId", "setAgentWorkflowEnabled"),
        args.isEnabled
      ),
    deleteAgentWorkflow: (args: any) =>
      method(manager, "deleteAgentWorkflow")(
        requirePath(args, "id", "deleteAgentWorkflow"),
        requirePath(args, "workflowId", "deleteAgentWorkflow"),
      ),
    runAgentWorkflowNow: (args: any) =>
      method(manager, "runAgentWorkflowNow")(
        requirePath(args, "id", "runAgentWorkflowNow"),
        requirePath(args, "workflowId", "runAgentWorkflowNow"),
      ),
    // `importAgentWorkflowText {}` answered
    // `500 {"error":"Invalid Sand agent id: undefined"}`, and with the id present
    // but no `markdown` it still answered `200` — importing nothing at all.
    importAgentWorkflowText: (args: any) =>
      method(manager, "importAgentWorkflowMarkdown")(
        requirePath(args, "id", "importAgentWorkflowText"),
        requireText(args, "markdown", "importAgentWorkflowText"),
        args.name
      ),
    // `POST /api/importAgentWorkflowUrl {}` and `{"id":"1111…"}` both answered
    // `500 {"error":"Cannot read properties of undefined (reading 'split')"}` —
    // the URL parser, reached with nothing to parse.
    importAgentWorkflowUrl: (args: any) =>
      method(manager, "importAgentWorkflowUrl")(
        requirePath(args, "id", "importAgentWorkflowUrl"),
        requireText(args, "url", "importAgentWorkflowUrl"),
        args.name),
    portAgentLocalSkills: (args: any) =>
      method(manager, "portAgentLocalSkills")(
        requirePath(args, "id", "portAgentLocalSkills")),
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

    // All three channel views are keyed by an agent id. Measured on a live box,
    // `POST /api/getAgentChannels {}` and `POST /api/refreshChannel {}` answered
    // `500 {"error":"Invalid Sand agent id: undefined"}`, and
    // `POST /api/disconnectChannel {}` the same. With an id that names nothing
    // they answer `200` carrying the box-wide channel manifest — a channel list
    // for an agent that does not exist, which reads as "this agent is connected to
    // nothing" and is really "the box has these two platforms available".
    getAgentChannels: (args: any) =>
      method(automations, "getAgentChannels")(
        requirePath(args, "id", "getAgentChannels")),
    connectChannel: async (args: any) => {
      requireFields(args, "connectChannel", [
        { field: "id" },
        { field: "platform" },
        { field: "token", allowEmpty: true },
      ]);
      method(manager, "connectChannel")(args.id, args.platform, args.token);
      return method(automations, "getAgentChannels")(args.id);
    },
    disconnectChannel: async (args: any) => {
      requireFields(args, "disconnectChannel", [
        { field: "id" },
        { field: "platform" },
      ]);
      method(manager, "disconnectChannel")(args.id, args.platform);
      return method(automations, "getAgentChannels")(args.id);
    },
    refreshChannel: (args: any) =>
      method(automations, "getAgentChannels")(
        requirePath(args, "id", "refreshChannel")),
    getListenerIntegrations: () =>
      method(automations, "getListenerIntegrations")(),
    getListenerConnectUrl: async (args: any) => ({
      // The platform name reaches a listener lookup one layer down, where a
      // missing one is a lookup for nothing. Naming the field here is the
      // difference between "fix the request" and "the listener subsystem is
      // broken".
      url: await method(automations, "getListenerConnectUrl")(
        requireText(args, "platform", "getListenerConnectUrl"),
      )
    }),
    // `POST /api/getSubagents {}` and `POST /api/getAsyncTasks {}` answered `200 []`
    // — "this agent has none" — for a request that named no agent at all. An
    // empty list is a real answer, and it is also the answer for a lost id.
    getSubagents: (args: any) =>
      method(manager, "getSubagents")(requirePath(args, "id", "getSubagents")),
    getAsyncTasks: (args: any) =>
      method(manager, "getAsyncTasks")(requirePath(args, "id", "getAsyncTasks")),
    // `Buffer.from(42, "base64")` is a TypeError from deep inside Node, and a
    // truncated base64 payload is the caller's, not the host's.
    setAgentAvatarBytes: (args: any) =>
      method(manager, "setAgentAvatarBytes")(
        requirePath(args, "id", "setAgentAvatarBytes"),
        args.pngBase64 == null
          ? null
          : Uint8Array.from(Buffer.from(
              requireText(args, "pngBase64", "setAgentAvatarBytes"), "base64"))
      ),
    getAgentAvatar: (args: any) =>
      method(manager, "getAgentAvatar")(requirePath(args, "id", "getAgentAvatar")),

    getForeverBoxStatus: async (args: any) =>
      deps.decorateForeverBoxStatus(
        await method(deps.extensions.api("forever-box"), "getStatus")(args)
      ),
    // `POST /api/getCloudAgentInfo {}` and `{"includeFiles":true}` answered
    // `500 {"error":"Cannot read properties of undefined (reading 'trim')"}` — the
    // cloud agent key, trimmed one layer down, on a request that carried none.
    getCloudAgentInfo: (args: any) =>
      method(deps.extensions.api("cloud-agents"), "getInfo")(
        requireText(args, "bcId", "getCloudAgentInfo"),
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
    // `endHandoff(undefined, "button")` is a lookup for a handoff nobody named.
    // `trigger` keeps its default on purpose — the button is the normal case.
    handBackForeverBox: (args: any) =>
      method(deps.extensions.api("session"), "endHandoff")(
        requirePath(args, "id", "handBackForeverBox"),
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
      /**
       * `routedAction` arrived and it named neither of the two legal values.
       *
       * The discriminator used to have no fall-through. Anything that matched
       * neither `if` above reached the `restart()` line below, so
       * `{"routedAction":"execute-tools"}` — one character of typo — reconnected
       * every MCP server, executed no tool, and answered `200`, which is exactly
       * what a routed-tool client reads as "your tool answered". A caller whose
       * request was wrong could not tell that from a successful reload, and
       * neither the status nor the body named the field.
       *
       * The refusal runs BEFORE the `completion` leg on purpose: an unknown
       * action and a pending handshake in the same body is still an unknown
       * action, and reading `completion` first would reopen the same hole with
       * one more field in it.
       *
       * `routedArgs` without an action is the same mistake the other way round —
       * the caller named the tool and lost the verb — and it is refused with the
       * name of the field it lost instead of with a reload.
       */
      if (routedAction !== undefined) {
        throw malformed(
          "refreshMcp",
          `"routedAction" must be "list-tools" or "execute-tool", and ${
            typeof routedAction === "string" && routedAction.length > 0
              ? JSON.stringify(routedAction)
              : arrivalType(routedAction)
          } arrived.`,
        );
      }
      if (routedArgs !== undefined) {
        throw malformed(
          "refreshMcp",
          '"routedAction" must be "list-tools" or "execute-tool" when "routedArgs" is present.',
        );
      }
      if (completion != null) {
        await deps.handleDesktopMcpAuthCompletion(completion);
        return;
      }
      /**
       * An absent `routedAction` with an absent `completion` is the reload the
       * shipped desktop asks for, and it is not a lost request.
       *
       * `refreshHostMcp` in `source/electron-main/mcp/mcp-desktop.ts` sends
       * exactly `completion == null ? {} : { completion }`, and seven marketplace
       * IPC handlers call it: `sand:mcp-install`, `sand:mcp-update-plugin-install`,
       * `sand:mcp-remove`, `sand:mcp-uninstall-plugin`, `sand:mcp-auth`,
       * `sand:mcp-rename-account` and `sand:mcp-remove-account`. The desktop
       * mutates MCP state through its OWN `SandMcpManager`; this host owns a
       * separate manager that caches the account config and the live clients.
       * The 0.18 bundle says so in the comment above its own `refreshMcp`:
       * "reload it here so a server the user just added or authenticated in the
       * marketplace is reconnected and surfaced to the agent without a host
       * restart". Refusing `{}` would break every install, removal, rename and
       * re-auth.
       */
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
      // It was the last refusal in this file still raising a plain `Error`, so
      // it was also the last one answered `500` for a request that is the
      // caller's own mistake.
      return method(deps.extensions.api("secrets"), "set")({
        secrets: requireObject(args, "secrets", "setBoxSecrets"),
      });
    },
    getBoxSecretsStatus: () =>
      method(deps.extensions.api("secrets"), "getStatus")()
  };
}
