import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { constants as zlibConstants, createGzip, gzip } from "node:zlib";
import { errorMessage } from "../shared/errors.js";
import { GATEWAY_API_PREFIX, GATEWAY_AUTH_SCHEME, GATEWAY_AVATARS_PATH, GATEWAY_EVENTS_PATH, GATEWAY_HEALTH_PATH, GATEWAY_MINT_DEDUPE_HEADER, GATEWAY_SLIM_AVATARS_HEADER, GATEWAY_TRACEPARENT_HEADER } from "../shared/gateway-wire.js";
import { GATEWAY_LOCAL_EXEC_REQUESTS_PATH, GATEWAY_LOCAL_EXEC_RESPONSES_PATH } from "../shared/local-exec-gateway.js";
import { parseTraceparent } from "../shared/observability/send-trace.js";
import { GATEWAY_WEBAUTHN_REQUESTS_PATH, GATEWAY_WEBAUTHN_RESPONSES_PATH } from "../shared/webauthn-gateway.js";
import { classifyGatewayCommandError } from "./gateway-command-error.js";
import { GATEWAY_PREPARE_UPGRADE_PATH, SAND_GATEWAY_COMMANDS, SAND_GATEWAY_SLIM_COMMANDS, isLoopbackHost, parseCommandArgs, stripInlineAvatarsFromEvent } from "./gateway-protocol.js";
import { isAgentNotFoundError } from "./extensions/session/agent-errors.js";

export class SandGatewayRequestError extends Error { constructor(message: string) { super(message); this.name = "SandGatewayRequestError"; } }
export const GATEWAY_REQUEST_ID_HEADER = "x-sand-request-id"; export const SSE_HEARTBEAT_MS = 15_000; export const MAX_REQUEST_PAYLOAD_BYTES = 256 * 1024 * 1024; export const MAX_BODY_BYTES = Math.ceil(MAX_REQUEST_PAYLOAD_BYTES * 4 / 3) + 64 * 1024; export const GZIP_MIN_BYTES = 1_400; export const DISABLE_SSE_GZIP_ENV = "SAND_DISABLE_GATEWAY_SSE_GZIP";
/**
 * The HTTP status a command failure is reported with.
 *
 * Four answers now, and the two that were missing are both about the caller.
 *
 *  - `SandGatewayRequestError` is `400`. It is the one class raised for a request
 *    the host read and refused on its own terms: a body that is not JSON, a
 *    field that is absent or the wrong type, a body over the size ceiling. Every
 *    one of those used to answer `500`, which told the caller the server broke
 *    and invited a retry of a request that can never succeed as written. Measured
 *    on a live box, `POST /api/deleteAgent {}` and `POST /api/searchAgents {}`
 *    both answered `500 {"error":"Malformed deleteAgent request: \"id\" must be a
 *    non-empty string."}` while `POST /api/deleteAgent {"id":` answered `400`
 *    for the same class of mistake — the JSON gate had a status and the field
 *    gates did not.
 *  - `SandAgentLimitError` and `SandSkillPublishError` are `409`: the request was
 *    well formed, the host understood it, and the state refuses it.
 *  - "That agent id names nothing" is `404`. It used to be `500`, which told the
 *    caller the server broke. Measured on a live box: a delete of an id nobody
 *    created, an update of one, and either of the two sidebar switches all
 *    answered `500 {"error":"No agent directory on disk for <id>"}` — and
 *    `getHealth` said the host was fine. A client cannot tell that from a crash,
 *    so it retries a request that can never succeed.
 *  - Everything else stays `500`.
 *
 * The `404` is decided by `isAgentNotFoundError`, which matches one error class
 * and a short list of names — never a message, and never the whole
 * `SandAgentLifecycleError` family. That family also carries a delete that lost
 * a race with a file handle and a summary that could not be built. Mapping it to
 * `404` would tell a client to retry a delete it must not retry, which is a worse
 * failure than the status code it replaces.
 *
 * `400` is matched by `instanceof`, not by name, and it is checked first. A
 * malformed request is by definition something the host never reached a callee
 * with, so it cannot also be a limit refusal or a missing agent; keeping the
 * branches apart is what lets each message stay about one fact.
 */
export function statusForCommandError(error: unknown): number { if (error instanceof SandGatewayRequestError) return 400; const name = error instanceof Error ? error.name : ""; if (name === "SandAgentLimitError" || name === "SandSkillPublishError") return 409; if (isAgentNotFoundError(error)) return 404; return 500; }
export async function readBody(req: AsyncIterable<unknown>): Promise<string> { const chunks: Buffer[] = []; let total = 0; for await (const chunk of req) { const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk as ArrayBuffer); total += buffer.length; if (total > MAX_BODY_BYTES) throw new SandGatewayRequestError("Request body is too large."); chunks.push(buffer); } return Buffer.concat(chunks).toString("utf8"); }
export function clientAcceptsGzip(req: IncomingMessage): boolean { const header = req.headers["accept-encoding"]; const value = Array.isArray(header) ? header.join(",") : header; return typeof value === "string" && value.toLowerCase().includes("gzip"); }
export function clientWantsSlimAvatars(req: IncomingMessage): boolean { const header = req.headers[GATEWAY_SLIM_AVATARS_HEADER]; return (Array.isArray(header) ? header[0] : header) === "1"; }
export function respondJson(res: ServerResponse, value: unknown, req?: IncomingMessage): void { const raw = Buffer.from(JSON.stringify(value ?? null), "utf8"); const respondRaw = () => { res.writeHead(200, { "content-type": "application/json", "content-length": raw.byteLength, [GATEWAY_MINT_DEDUPE_HEADER]: "1" }); res.end(raw); }; if (req != null && raw.byteLength >= GZIP_MIN_BYTES && clientAcceptsGzip(req)) { gzip(raw, (error, zipped) => { if (res.destroyed || res.writableEnded || res.headersSent) return; if (error != null) return respondRaw(); res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": zipped.byteLength, vary: "Accept-Encoding", [GATEWAY_MINT_DEDUPE_HEADER]: "1" }); res.end(zipped); }); return; } respondRaw(); }
export function respondError(res: ServerResponse, status: number, message: string): void { const body = JSON.stringify({ error: message }); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); res.end(body); }
export function isAuthorized(req: IncomingMessage, expectedToken: string): boolean { const header = req.headers.authorization; if (typeof header !== "string") return false; const prefix = `${GATEWAY_AUTH_SCHEME} `; if (!header.startsWith(prefix)) return false; const provided = Buffer.from(header.slice(prefix.length)); const expected = Buffer.from(expectedToken); return provided.length === expected.length && timingSafeEqual(provided, expected); }
export function hostHeaderHostname(req: IncomingMessage): string | null { const header = req.headers.host; if (typeof header !== "string" || header.length === 0) return null; try { return new URL(`http://${header}`).hostname; } catch { return null; } }
export function rejectUntrustedBrowserRequest(deps: { authToken?: string }, req: IncomingMessage, res: ServerResponse): boolean { if (req.headers.origin !== undefined) { respondError(res, 403, "browser-origin gateway requests are not allowed"); return true; } if (deps.authToken == null) { const hostname = hostHeaderHostname(req); if (hostname == null || !isLoopbackHost(hostname)) { respondError(res, 403, "untrusted gateway host"); return true; } } return false; }
function headerValue(req: IncomingMessage, name: string): string | undefined { const raw = req.headers[name]; const value = Array.isArray(raw) ? raw[0] : raw; return typeof value === "string" && value.length > 0 ? value : undefined; }
function commandTrace(req: IncomingMessage) { const traceparent = headerValue(req, GATEWAY_TRACEPARENT_HEADER); const parsed = parseTraceparent(traceparent); return parsed == null ? {} : { traceparent, traceId: parsed.traceId, spanId: parsed.spanId }; }

export interface GatewayServerDeps {
  readonly api: { getAgentAvatar(...args: any[]): any; [name: string]: (...args: any[]) => any }; readonly subscribe: (listener: (event: any) => void) => () => void; readonly getHealth: () => Record<string, any>; readonly startedAt: number;
  readonly host?: string; readonly port?: number; readonly authToken?: string; readonly tls?: { cert: Buffer; key: Buffer };
  readonly prepareForUpgrade?: () => Promise<unknown>; readonly onCommandError?: (report: Record<string, unknown>) => void; readonly onCommandComplete?: (report: Record<string, unknown>) => void;
  readonly onEventStreamClosed?: () => void; readonly onDesktopContact?: () => void;
  readonly localExec?: { registerProvider(listener: (frame: unknown) => void): () => void; submitResponses(batch: unknown): void };
  readonly webauthn?: { registerProvider(listener: (frame: unknown) => void): () => void; submitResponses(batch: unknown): void };
}

/**
 * Rejects a body the command table cannot read, before it is handed one.
 *
 * Measured on a live box: `POST /api/deleteAgent {"id":` answered
 * `500 {"error":"Unexpected end of JSON input"}` — one V8 sentence, no command,
 * no field, and a status that blames the server for the caller's typo. The parse
 * lives inside each table entry, so the dispatcher sees only the `SyntaxError`.
 * Parsing once here as a gate costs a second parse of an already buffered string
 * and leaves the table signature alone; a body that parses still reaches the same
 * handler with the same bytes.
 *
 * `shape: "object"` adds the second half of the contract, and it is what the
 * command routes ask for. A command body is a JSON *object*: every entry of
 * `SAND_GATEWAY_COMMANDS` reads named fields off what `parseCommandArgs` returns.
 * The four values that are not objects parse cleanly and then fail one line
 * later on a property read — a measured sweep of all 122 commands found
 * `POST /api/dismissWidget null`,
 * `500 {"error":"Cannot read properties of null (reading 'agentId')"}`, and nine
 * more of exactly that shape (`createAgent`, `openAgent`, `setWindowFocused`,
 * `broadcastToAgents`, `setBoxMigrating`, `resumeBoxAfterRecreate`,
 * `setHostSettings`, `refreshMcp`, `listBoxMcpServers`), each naming neither the
 * command nor the body. Refusing them here turns ten scattered V8 sentences into
 * one `400` that says which endpoint was sent something that is not a request.
 *
 * The bridge routes keep the looser gate. They do not read named fields — each
 * hands the parsed value straight to `submitResponses` — so demanding an object
 * there would be a new rule rather than the enforcement of an existing one.
 */
export function refuseUnparsableBody(method: string, body: string, res: ServerResponse, shape: "any" | "object" = "any"): boolean {
  let parsed: unknown;
  try { parsed = parseCommandArgs(body); } catch { respondError(res, 400, `Malformed ${method} request: the body is not valid JSON.`); return true; }
  if (shape === "object" && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
    respondError(res, 400, `Malformed ${method} request: the body must be a JSON object, and ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed} arrived.`);
    return true;
  }
  return false;
}

export async function routeCommand(deps: GatewayServerDeps, method: string, body: string, res: ServerResponse, req: IncomingMessage): Promise<void> { if (!Object.hasOwn(SAND_GATEWAY_COMMANDS, method)) return respondError(res, 404, `unknown gateway method: ${method}`); if (refuseUnparsableBody(method, body, res, "object")) return; const table = clientWantsSlimAvatars(req) ? SAND_GATEWAY_SLIM_COMMANDS : SAND_GATEWAY_COMMANDS; const handler = (table as Record<string, (api: unknown, body: string) => unknown>)[method]; if (handler == null) return respondError(res, 404, `unknown gateway method: ${method}`); const requestId = headerValue(req, GATEWAY_REQUEST_ID_HEADER); const { traceparent: _parent, ...traceIds } = commandTrace(req); const startedAt = Date.now(); let result: unknown; try { result = await handler(deps.api, body); } catch (error) { if (deps.onCommandError != null && statusForCommandError(error) >= 500) { try { deps.onCommandError({ method, ...classifyGatewayCommandError(error), durationMs: Date.now() - startedAt, requestId, ...traceIds }); } catch {} } throw error; } if (deps.onCommandComplete != null) { try { deps.onCommandComplete({ method, durationMs: Date.now() - startedAt, requestId, ...traceIds }); } catch {} } respondJson(res, result, req); }

export function openSseStream(req: IncomingMessage, res: ServerResponse, register: (write: (data: string) => void) => () => void): void { const gzipEnabled = process.env[DISABLE_SSE_GZIP_ENV] !== "1" && clientAcceptsGzip(req); res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", ...(gzipEnabled ? { "content-encoding": "gzip", vary: "Accept-Encoding" } : {}) }); const zipper = gzipEnabled ? createGzip({ flush: zlibConstants.Z_SYNC_FLUSH }) : null; zipper?.pipe(res); const sink = zipper ?? res; sink.write("retry: 1000\n\n"); const unsubscribe = register((data) => sink.write(`data: ${data}\n\n`)); const heartbeat = setInterval(() => sink.write(":ping\n\n"), SSE_HEARTBEAT_MS); res.on("close", () => { clearInterval(heartbeat); unsubscribe(); zipper?.destroy(); }); }
export function parseSubscribedChannels(url: URL): Set<string> | undefined { const raw = url.searchParams.get("channels"); if (raw === null) return undefined; const channels = raw.split(",").map((value) => value.trim()).filter(Boolean); return channels.length > 0 ? new Set(channels) : undefined; }
function handleEvents(deps: GatewayServerDeps, req: IncomingMessage, res: ServerResponse, channels?: Set<string>): void { const slim = clientWantsSlimAvatars(req); res.on("close", () => deps.onEventStreamClosed?.()); openSseStream(req, res, (write) => deps.subscribe((event) => { if (channels != null && !channels.has(event.channel)) return; write(JSON.stringify(slim ? stripInlineAvatarsFromEvent(event) : event)); })); }
const DATA_URL_PATTERN = /^data:([a-z0-9.+/-]+);base64,(.*)$/i; const AVATAR_NO_EXECUTE_HEADERS = { "content-disposition": "attachment", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
/**
 * The avatar bytes for one agent, or a status that names why there are none.
 *
 * `decodeURIComponent` raises a bare `URIError: URI malformed` on a truncated
 * escape such as `%ZZ`, and an unhandled throw here answers `500` with that V8
 * sentence. The id is caller-supplied, so a caller that mangles it is told so
 * and pointed at the encoding rather than shown a server fault. Measured
 * against a synthetic request; the loopback box answers `%ZZ` as `404` because
 * `HttpWebRequest` re-encodes the path before it reaches the socket.
 */
async function handleAvatarImage(deps: GatewayServerDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> { if (req.headers["sec-fetch-site"] === "cross-site") return respondError(res, 403, "cross-site avatar loads are not allowed"); let agentId = ""; try { agentId = decodeURIComponent(url.pathname.slice(GATEWAY_AVATARS_PATH.length + 1)); } catch { return respondError(res, 400, "the agent id in the avatar path is not valid percent-encoding."); } if (agentId.length === 0) return respondError(res, 404, "missing agent id"); const avatar = await deps.api.getAgentAvatar({ id: agentId }) as { dataUrl?: string | null; version?: string | null }; const match = avatar.dataUrl == null ? null : DATA_URL_PATTERN.exec(avatar.dataUrl); if (avatar.version == null || match?.[1] == null || match[2] == null) return respondError(res, 404, "agent has no avatar"); const requested = url.searchParams.get("v"); if (requested != null && requested !== avatar.version) return respondError(res, 404, "no such avatar version"); const etag = `"${avatar.version}"`; const cache = requested != null ? { "cache-control": "private, max-age=31536000, immutable", etag } : { "cache-control": "no-store", etag }; if (req.headers["if-none-match"] === etag) { res.writeHead(304, cache); res.end(); return; } const bytes = Buffer.from(match[2], "base64"); res.writeHead(200, { ...cache, ...AVATAR_NO_EXECUTE_HEADERS, "content-type": match[1], "content-length": bytes.byteLength }); res.end(bytes); }
function handleBridgeRequests(bridge: GatewayServerDeps["localExec"] | GatewayServerDeps["webauthn"], missing: string, req: IncomingMessage, res: ServerResponse): void { if (bridge == null) return respondError(res, 404, missing); openSseStream(req, res, (write) => bridge.registerProvider((frame) => write(JSON.stringify(frame)))); }
/**
 * The POST half of a bridge channel: the caller hands back the answers its SSE
 * stream asked for, as JSON.
 *
 * The parse was unguarded, and these two routes skip `routeCommand` entirely —
 * they are the only places that read a body without passing `refuseUnparsableBody`
 * first. Measured on a live box, `POST /local-exec/responses {"broken` and
 * `POST /webauthn/responses {"broken` both answered `500 {"error":"Unterminated
 * string in JSON at position 8 (line 1 column 9)"}`: a V8 parser sentence with no
 * endpoint in it and a status that blames the host for the caller's truncated
 * write. The same gate the command routes use is applied here, with the route's
 * own path as the name, so the answer says which endpoint and that the body is
 * what is wrong.
 */
function handleBridgeResponses(bridge: GatewayServerDeps["localExec"] | GatewayServerDeps["webauthn"], missing: string, channel: string, body: string, res: ServerResponse): void { if (bridge == null) return respondError(res, 404, missing); if (refuseUnparsableBody(channel, body, res)) return; bridge.submitResponses(body.length > 0 ? JSON.parse(body) : {}); respondJson(res, { ok: true }); }

export async function handleRequest(deps: GatewayServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1"); if (rejectUntrustedBrowserRequest(deps, req, res)) return;
  // This handler stays ABOVE the bearer check on purpose: `fetchHealth` in
  // source/node-agent-coordinator/gateway/host-supervisor.ts probes /health with
  // no Authorization header, and requiring the token here would turn every
  // reachability report into a 401. That is also why the answer must not carry
  // identifiers. One token governs ~124 commands and lives in plaintext in
  // <root>\gateway.json, so anything running as this user -- including the agent
  // -- can reach loopback; `pid` said which process to signal and
  // `activeAgentId` said which agent to target, both before presenting any
  // credential. `ok`, `isBusy` and `startedAt` are what "alive or busy" needs,
  // and no consumer in this repository reads the two that were removed.
  if (req.method === "GET" && url.pathname === GATEWAY_HEALTH_PATH) { const health = deps.getHealth(); return respondJson(res, { ok: true, isBusy: health.isBusy, ...(health.busyOnlyAwaitingApproval === undefined ? {} : { busyOnlyAwaitingApproval: health.busyOnlyAwaitingApproval }), startedAt: deps.startedAt, lastBusyAtMs: health.lastBusyAtMs }); }
  const events = req.method === "GET" && url.pathname === GATEWAY_EVENTS_PATH; const prepare = req.method === "POST" && url.pathname === GATEWAY_PREPARE_UPGRADE_PATH; const avatar = req.method === "GET" && url.pathname.startsWith(`${GATEWAY_AVATARS_PATH}/`); const localRequests = req.method === "GET" && url.pathname === GATEWAY_LOCAL_EXEC_REQUESTS_PATH; const localResponses = req.method === "POST" && url.pathname === GATEWAY_LOCAL_EXEC_RESPONSES_PATH; const webRequests = req.method === "GET" && url.pathname === GATEWAY_WEBAUTHN_REQUESTS_PATH; const webResponses = req.method === "POST" && url.pathname === GATEWAY_WEBAUTHN_RESPONSES_PATH; const command = req.method === "POST" && url.pathname.startsWith(`${GATEWAY_API_PREFIX}/`);
  if (!(events || prepare || avatar || localRequests || localResponses || webRequests || webResponses || command)) return respondError(res, 404, `not found: ${req.method} ${url.pathname}`);
  if ((localRequests || localResponses) && deps.authToken == null) return respondError(res, 401, "local-exec requires gateway authentication"); if ((webRequests || webResponses) && deps.authToken == null) return respondError(res, 401, "webauthn requires gateway authentication"); if (deps.authToken != null && !isAuthorized(req, deps.authToken)) return respondError(res, 401, "unauthorized");
  if (prepare) return respondJson(res, deps.prepareForUpgrade != null ? await deps.prepareForUpgrade() : { quiescing: false, runningTurns: 0 }); if (localRequests || localResponses) deps.onDesktopContact?.();
  if (localRequests) return handleBridgeRequests(deps.localExec, "local-exec channel not enabled", req, res); if (localResponses) return handleBridgeResponses(deps.localExec, "local-exec channel not enabled", GATEWAY_LOCAL_EXEC_RESPONSES_PATH, await readBody(req), res); if (webRequests) return handleBridgeRequests(deps.webauthn, "webauthn channel not enabled", req, res); if (webResponses) return handleBridgeResponses(deps.webauthn, "webauthn channel not enabled", GATEWAY_WEBAUTHN_RESPONSES_PATH, await readBody(req), res); if (events) return handleEvents(deps, req, res, parseSubscribedChannels(url)); if (avatar) return handleAvatarImage(deps, req, res, url);
  return routeCommand(deps, url.pathname.slice(GATEWAY_API_PREFIX.length + 1), await readBody(req), res, req);
}

export async function startGatewayServer(deps: GatewayServerDeps) { const host = deps.host ?? "127.0.0.1"; const listener = (req: IncomingMessage, res: ServerResponse) => { void handleRequest(deps, req, res).catch((error) => { if (!res.headersSent) respondError(res, statusForCommandError(error), errorMessage(error)); else res.end(); }); }; const server = deps.tls == null ? createHttpServer(listener) : createHttpsServer({ cert: deps.tls.cert, key: deps.tls.key }, listener); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(deps.port ?? 0, host, () => { server.off("error", reject); resolve(); }); }); const address = server.address(); if (address == null || typeof address === "string") throw new Error("gateway did not bind a TCP address"); return { port: address.port, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error != null ? reject(error) : resolve()); }) }; }
