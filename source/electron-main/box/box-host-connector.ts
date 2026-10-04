import type { PartialMessage } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { type EnsureSandBoxRequest, type EnsureSandBoxResponse, type ForceRecreateSandBoxRequest, type RecreateSandBoxRequest, type RecreateSandBoxResponse } from "../../packages/proto/generated/aiserver/v1/sand_box_pb.js";
import { GrokBotService } from "../../packages/proto/generated/aiserver/v1/grok_bot_connect.js";
import { ErrorDetails } from "../../packages/proto/generated/aiserver/v1/utils_pb.js";
import { createSandCursorBackendClient, getSandInferenceBackendUrl } from "../../shared/node/cursor-backend/cursor-inference.js";
import { getAccessTokenExpiryMs } from "../../shared/node/cursor-token.js";
import { getSandBackendClientHeaders } from "../../shared/node/sand-client-metadata.js";
import { parseSandBoxMigrationOperationId } from "../../shared/box-migration.js";
import { GATEWAY_ACCESS_DENIED_MESSAGE_MARKER, CLOUD_AGENT_STORAGE_DISABLED, GATEWAY_NO_STORAGE_MESSAGE_MARKER, SAND_BOX_BLOCKED, SAND_BOX_BLOCK_REASON_KEY, encodeSandBoxBlockedMessage, type SandBoxBlockedInfo } from "../../shared/gateway-reachability.js";
import { GATEWAY_NETWORK_TOKEN_HEADER } from "../../shared/gateway-wire.js";
import { createGatewayConnectFastPath, type GatewayConnection, type GatewayDescriptorStore } from "./gateway-descriptor-cache.js";
import type { RecreateResult } from "./box-recreate-commands.js";

export const LOCAL_EXEC_DAEMON_CREDENTIAL_PATH = "/sand-box/local-exec-daemon-credential";
export const GATEWAY_URL_ENV = "SAND_HOST_GATEWAY_URL";
export const GATEWAY_TOKEN_ENV = "SAND_HOST_GATEWAY_TOKEN";
export const GATEWAY_NETWORK_TOKEN_ENV = "SAND_HOST_GATEWAY_NETWORK_TOKEN";
export const AUTOMATION_FAILURE_HINT_HEADER = "x-automation-failure-hint";
export const SAND_UPDATE_REQUIRED_HINT = "SAND_CLIENT_UPDATE_REQUIRED";
export const BOX_BLOCKED_FALLBACK_HOLD_MS = 60_000;
export const BOX_BLOCKED_MAX_HOLD_MS = 15 * 60_000;

export class SandBoxHostConnectError extends Error {}
export class SandComputerRecreateRefusedError extends Error {}

/**
 * Name of the refusal `account/cursor-auth.ts` raises from `getValidAccessToken`
 * when no account is signed in. The connector recognises it by name instead of
 * importing the class: pulling `account/cursor-auth.ts` in here would drag the
 * whole account service and its electron secret store into the box module graph.
 * Renaming the class breaks `tests/local-box-connection.test.mjs`, which pins both
 * halves against the real module.
 */
export const SIGN_IN_REQUIRED_ERROR_NAME = "SandAuthSignInRequiredError";

/**
 * A credential refusal is permanent. No retry, reconnect or reconnect-and-hope can
 * mint a token, so it must reach the coordinator carrying an outcome the UI can
 * name. The shared access-denied marker is that carrier: `classifyGatewayFetchFailure`
 * maps it to `access_denied`, which `PERMANENT_REFUSAL_KINDS` already lists, so the
 * roster read stops reporting "Can't reach your computer" and stops burning a retry.
 */
export const SIGN_IN_REQUIRED_ACCESS_DENIED_MESSAGE = `${GATEWAY_ACCESS_DENIED_MESSAGE_MARKER}: no signed-in account, so the box broker cannot be reached`;

export interface BrokerBox { gatewayUrl: string; gatewayToken: string; networkToken: string; vncUrl: string; forkVncBaseUrl: string }
export interface BrokerClient {
  ensureSandBox(request: PartialMessage<EnsureSandBoxRequest>): Promise<EnsureSandBoxResponse>;
  recreateSandBox(request: PartialMessage<RecreateSandBoxRequest>): Promise<RecreateSandBoxResponse>;
  forceRecreateSandBox(request: PartialMessage<ForceRecreateSandBoxRequest>): Promise<RecreateSandBoxResponse>;
}
export interface BrokerDeps {
  getAccessToken(options: { backendUrl: string }): Promise<string>;
  getMachineId(): Promise<string> | string;
}

export interface SandRemoteHostConnector {
  connect(): Promise<GatewayConnection>;
  recreate?(args: { readonly preserveData: boolean; readonly force?: boolean }): Promise<RecreateResult>;
  forceRecreate?(): Promise<RecreateResult>;
  issueLocalExecDaemonCredential?(): Promise<{ readonly credential: string; readonly backendUrl: string; readonly expiresAtMs?: number } | undefined>;
  issueInferenceCredential?(): Promise<{ readonly accessToken: string; readonly backendUrl: string; readonly expiresAtMs: number } | undefined>;
}

export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, BOX_BLOCKED_MAX_HOLD_MS) : undefined;
}

export function buildConnection(baseUrl: string, token: string, networkToken: string, vncUrls?: { primaryUrl: string; forkBaseUrl: string }): GatewayConnection {
  const isPodProxied = networkToken.length > 0 && vncUrls != null && vncUrls.primaryUrl.length > 0 && vncUrls.forkBaseUrl.length > 0;
  return {
    baseUrl,
    ...(token.length > 0 ? { token } : {}),
    ...(networkToken.length > 0 ? { headers: { [GATEWAY_NETWORK_TOKEN_HEADER]: networkToken } } : {}),
    ...(isPodProxied ? { vncProxy: { ...vncUrls, networkToken } } : {}),
  };
}

function readBlockedInfoOrEmpty(error: ConnectError): SandBoxBlockedInfo {
  const details = error.findDetails(ErrorDetails)[0]?.details;
  return {
    reason: details?.additionalInfo[SAND_BOX_BLOCK_REASON_KEY] ?? "",
    title: details?.title ?? "",
    detail: details?.detail ?? "",
  };
}
function blockedError(info: SandBoxBlockedInfo, cause?: ConnectError): ConnectError {
  return new ConnectError(encodeSandBoxBlockedMessage(info), cause?.code ?? Code.ResourceExhausted, cause?.metadata, undefined, cause);
}

/**
 * Walks the cause chain looking for the sign-in refusal. The transport interceptor
 * calls `deps.getAccessToken` inside the request, so the refusal is whatever the
 * credential dependency threw, wrapped or not.
 */
export function isSignInRequiredFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const node = current as { readonly name?: unknown; readonly constructor?: { readonly name?: unknown }; readonly cause?: unknown };
    if (node.name === SIGN_IN_REQUIRED_ERROR_NAME || node.constructor?.name === SIGN_IN_REQUIRED_ERROR_NAME) return true;
    current = node.cause;
  }
  return false;
}

export class BrokeredHostConnector {
  private blocked: { info: SandBoxBlockedInfo; untilMs: number } | undefined;
  private readonly client: BrokerClient;
  constructor(private readonly deps: BrokerDeps, client?: BrokerClient, private readonly updateSink?: { noteBackendUpdateRequirement(required: boolean): void }) {
    this.client = client ?? createSandCursorBackendClient(GrokBotService, deps);
  }

  async connect(): Promise<GatewayConnection> {
    if (this.blocked != null && Date.now() < this.blocked.untilMs) throw blockedError(this.blocked.info);
    let box: BrokerBox;
    try { box = await this.client.ensureSandBox({}); }
    catch (error) {
      if (error instanceof ConnectError && error.metadata.get(AUTOMATION_FAILURE_HINT_HEADER) === CLOUD_AGENT_STORAGE_DISABLED) throw new ConnectError(GATEWAY_NO_STORAGE_MESSAGE_MARKER, error.code, error.metadata, undefined, error);
      if (error instanceof ConnectError && error.metadata.get(AUTOMATION_FAILURE_HINT_HEADER) === SAND_BOX_BLOCKED) {
        const info = readBlockedInfoOrEmpty(error);
        this.blocked = { info, untilMs: Date.now() + (parseRetryAfterMs(error.metadata.get("retry-after")) ?? BOX_BLOCKED_FALLBACK_HOLD_MS) };
        throw blockedError(info, error);
      }
      if (error instanceof ConnectError && error.metadata.get(AUTOMATION_FAILURE_HINT_HEADER) === SAND_UPDATE_REQUIRED_HINT) this.updateSink?.noteBackendUpdateRequirement(true);
      if (error instanceof ConnectError && error.metadata.get(AUTOMATION_FAILURE_HINT_HEADER) == null && (error.code === Code.Unauthenticated || error.code === Code.PermissionDenied)) throw new ConnectError(GATEWAY_ACCESS_DENIED_MESSAGE_MARKER, error.code, error.metadata, undefined, error);
      // Nobody is signed in, so the request never left this process. Reporting it
      // raw would let `classifyGatewayFetchFailure` file it under `network`, and the
      // sidebar would tell a signed-out user their computer is unreachable.
      if (isSignInRequiredFailure(error)) throw new ConnectError(SIGN_IN_REQUIRED_ACCESS_DENIED_MESSAGE, Code.Unauthenticated, undefined, undefined, error);
      throw error;
    }
    this.blocked = undefined;
    this.updateSink?.noteBackendUpdateRequirement(false);
    if (box.gatewayUrl.length === 0) throw new SandBoxHostConnectError("Broker did not expose the in-box Sand gateway (gateway_url empty); the backend stamps it on every box — check the backend version/logs.");
    return buildConnection(box.gatewayUrl, box.gatewayToken, box.networkToken, { primaryUrl: box.vncUrl, forkBaseUrl: box.forkVncBaseUrl });
  }

  async recreate({ preserveData, force = false }: { preserveData: boolean; force?: boolean }) {
    const result = await this.client.recreateSandBox({ preserveData, force });
    if (!result.started) throw new SandComputerRecreateRefusedError(`Couldn't ${preserveData ? "update" : "reset"} the computer${result.reason.length > 0 ? ` (${result.reason})` : ""}. It is unchanged.`);
    const operationId = parseSandBoxMigrationOperationId(result.operationId);
    return operationId == null ? { status: "started-untrackable" as const } : { status: "started" as const, operationId };
  }
  async forceRecreate() {
    const result = await this.client.forceRecreateSandBox({});
    if (result.started) {
      const operationId = parseSandBoxMigrationOperationId(result.operationId);
      return operationId == null ? { status: "started-untrackable" as const } : { status: "started" as const, operationId };
    }
    return { status: "rejected" as const, reason: `Couldn't reset the computer${result.reason.length > 0 ? ` (${result.reason})` : ""}. It is unchanged.` };
  }
  async issueLocalExecDaemonCredential(): Promise<{ credential: string; backendUrl: string; expiresAtMs?: number } | undefined> {
    const backendUrl = getSandInferenceBackendUrl();
    let accessToken: string;
    try { accessToken = await this.deps.getAccessToken({ backendUrl }); } catch { return undefined; }
    let response: Response;
    try { response = await fetch(new URL(LOCAL_EXEC_DAEMON_CREDENTIAL_PATH, backendUrl).toString(), { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...getSandBackendClientHeaders(), "x-ghost-mode": "true" }, body: "{}" }); } catch { return undefined; }
    if (!response.ok) return undefined;
    let parsed: unknown; try { parsed = await response.json(); } catch { return undefined; }
    if (typeof parsed !== "object" || parsed == null) return undefined;
    const credential = Reflect.get(parsed, "credential");
    if (typeof credential !== "string" || credential.length === 0) return undefined;
    const expiresAtMs = Reflect.get(parsed, "expiresAtMs");
    return { credential, backendUrl, ...(typeof expiresAtMs === "number" ? { expiresAtMs } : {}) };
  }
  async issueInferenceCredential(): Promise<{ accessToken: string; backendUrl: string; expiresAtMs: number } | undefined> {
    const backendUrl = getSandInferenceBackendUrl();
    try {
      const accessToken = await this.deps.getAccessToken({ backendUrl });
      if (accessToken.length === 0) return undefined;
      return { accessToken, backendUrl, expiresAtMs: getAccessTokenExpiryMs(accessToken) ?? Date.now() + 10 * 60_000 };
    } catch { return undefined; }
  }
}

export class EnvDescriptorHostConnector {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async connect(): Promise<GatewayConnection> {
    const baseUrl = this.env[GATEWAY_URL_ENV]?.trim();
    if (baseUrl == null || baseUrl.length === 0) throw new SandBoxHostConnectError(`${GATEWAY_URL_ENV} is not set`);
    return buildConnection(baseUrl, this.env[GATEWAY_TOKEN_ENV]?.trim() ?? "", this.env[GATEWAY_NETWORK_TOKEN_ENV]?.trim() ?? "");
  }
  /**
   * Both credentials are minted by the Cursor backend, not by the gateway this
   * connector points at. An external host cannot mint either, so local exec and
   * box-side inference stay off for that configuration.
   *
   * These methods must still exist. `adapters/coordinator-gateway.ts` calls
   * `requireFunction(remote?.issueLocalExecDaemonCredential, ...)` while it builds
   * the binding, before `createWindow()`, and a missing method there threw a
   * wiring error that `main.ts` swallowed into telemetry — a headless process with
   * no window and no visible error. Returning `undefined` is the honest answer:
   * `coordinator-executors.mintLocalExecDaemonCredential` maps it to `null`, and
   * `local-exec/supervisor.refreshCredential` returns without handing anything off.
   */
  async issueLocalExecDaemonCredential(): Promise<{ readonly credential: string; readonly backendUrl: string; readonly expiresAtMs?: number } | undefined> { return undefined; }
  async issueInferenceCredential(): Promise<{ readonly accessToken: string; readonly backendUrl: string; readonly expiresAtMs: number } | undefined> { return undefined; }
}

export function createRemoteHostConnector(deps: BrokerDeps, env: NodeJS.ProcessEnv = process.env, updateSink?: { noteBackendUpdateRequirement(required: boolean): void }, descriptorFastPath?: { store: GatewayDescriptorStore; getAccountScope(): string | undefined }): SandRemoteHostConnector {
  if ((env[GATEWAY_URL_ENV]?.trim() ?? "").length > 0) return new EnvDescriptorHostConnector(env);
  const broker = new BrokeredHostConnector(deps, undefined, updateSink);
  if (descriptorFastPath == null) return broker;
  return { connect: createGatewayConnectFastPath(broker, descriptorFastPath), recreate: broker.recreate.bind(broker), forceRecreate: broker.forceRecreate.bind(broker), issueLocalExecDaemonCredential: broker.issueLocalExecDaemonCredential.bind(broker), issueInferenceCredential: broker.issueInferenceCredential.bind(broker) };
}
