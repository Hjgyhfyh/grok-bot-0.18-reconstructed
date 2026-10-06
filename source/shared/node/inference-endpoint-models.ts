/**
 * Read-only model discovery for a user-owned OpenAI-compatible endpoint.
 *
 * The Router settings panel needs the ids an endpoint advertises so the user
 * does not have to remember them. Every failure mode degrades to "no list, type
 * it yourself": this module never throws and never returns the API key, not in
 * a field, not in a display string, and not in a reason code.
 */

export const SAND_ENDPOINT_MODEL_LIST_TIMEOUT_MS = 5_000;
export const SAND_ENDPOINT_MODEL_LIST_LIMIT = 2_000;
const SAND_ENDPOINT_MODEL_ID_MAX = 200;
const SAND_ENDPOINT_MODEL_NAME_MAX = 200;
const SAND_ENDPOINT_BASE_URL_MAX = 2_048;
/** Below this length a substring match is noise rather than a leaked credential. */
const SAND_ENDPOINT_SECRET_GUARD_MIN = 8;

const SAND_ENDPOINT_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type SandEndpointModelReason =
  | "insecure-url"
  | "missing-credential"
  | "unauthorized"
  | "http-status"
  | "invalid-response"
  | "no-models"
  | "timeout"
  | "network-error"
  | "unsupported";

export interface SandEndpointModelOption {
  readonly id: string;
  readonly name: string | null;
}

export interface SandEndpointModelListing {
  /** `ok` only when at least one usable id came back. */
  readonly status: "ok" | "unavailable";
  /** The probed URL with credentials, query and fragment removed. */
  readonly endpoint: string;
  readonly models: readonly SandEndpointModelOption[];
  readonly truncated: boolean;
  readonly reason: SandEndpointModelReason | null;
}

export interface SandEndpointModelProbeTarget {
  readonly url: string;
  readonly report: string;
}

export interface SandEndpointModelParse {
  readonly models: readonly SandEndpointModelOption[];
  readonly truncated: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function clampedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/** Drops any option that repeats the credential, so a chatty endpoint cannot echo it back. */
function leaksSecret(id: string, name: string | null, apiKey: string | null): boolean {
  const secret = apiKey?.trim() ?? "";
  if (secret.length < SAND_ENDPOINT_SECRET_GUARD_MIN) return false;
  if (id.includes(secret)) return true;
  return name != null && name.includes(secret);
}

export function isSandEndpointModelBaseUrlAllowed(baseUrl: unknown): boolean {
  return sandEndpointModelProbeTarget(baseUrl) !== null;
}

/**
 * Resolves `{baseUrl}/models`, refusing anything that is not https (or http on
 * loopback) and refusing embedded credentials. Query and fragment are dropped
 * so the reported endpoint can never carry a key.
 *
 * The probe is assembled as a string and parsed against `url.origin`, so a
 * `pathname` that itself starts with `//` makes the whole reference
 * protocol-relative: `new URL("//evil.example.com/v1/models", "https://api.example.com")`
 * is `https://evil.example.com/v1/models`. The typed host silently stopped being the
 * host the stored credential was scoped to, and the reply came back tagged `ok` under
 * the endpoint the user typed. Pinning the origin from the parsed URL and appending the
 * path to `origin + path` keeps every probe on the host that passed the https/loopback
 * and credential checks above.
 */
export function sandEndpointModelProbeTarget(baseUrl: unknown): SandEndpointModelProbeTarget | null {
  if (typeof baseUrl !== "string") return null;
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0 || trimmed.length > SAND_ENDPOINT_BASE_URL_MAX) return null;
  let url: URL;
  try { url = new URL(trimmed); } catch { return null; }
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.hostname.length === 0) return null;
  const loopback = url.protocol === "http:" && SAND_ENDPOINT_LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopback) return null;
  url.search = "";
  url.hash = "";
  const basePath = url.pathname.replace(/\/+$/u, "");
  const probe = new URL(`${url.origin}${basePath}/models`);
  return { url: probe.toString(), report: `${probe.origin}${probe.pathname}` };
}

function modelOption(entry: unknown, apiKey: string | null): SandEndpointModelOption | null {
  if (typeof entry === "string") {
    const id = clampedText(entry, SAND_ENDPOINT_MODEL_ID_MAX);
    return id == null || leaksSecret(id, null, apiKey) ? null : { id, name: null };
  }
  const model = record(entry);
  if (model === null) return null;
  const id = clampedText(model["id"], SAND_ENDPOINT_MODEL_ID_MAX) ?? clampedText(model["model"], SAND_ENDPOINT_MODEL_ID_MAX);
  if (id === null || leaksSecret(id, null, apiKey)) return null;
  const name = clampedText(model["display_name"], SAND_ENDPOINT_MODEL_NAME_MAX)
    ?? clampedText(model["displayName"], SAND_ENDPOINT_MODEL_NAME_MAX)
    ?? clampedText(model["name"], SAND_ENDPOINT_MODEL_NAME_MAX);
  if (name !== null && leaksSecret(id, name, apiKey)) return null;
  return { id, name: name === id ? null : name };
}

/** Accepts `["id", …]` and `[{ id | model, name? }, …]`; anything else is a malformed payload. */
export function parseSandEndpointModelPayload(
  payload: unknown,
  apiKey: string | null = null,
  limit: number = SAND_ENDPOINT_MODEL_LIST_LIMIT,
): SandEndpointModelParse | null {
  const body = record(payload);
  if (body === null) return null;
  const data = body["data"];
  if (!Array.isArray(data)) return null;
  const models: SandEndpointModelOption[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const entry of data) {
    if (models.length >= limit) { truncated = true; break; }
    const option = modelOption(entry, apiKey);
    if (option === null || seen.has(option.id)) continue;
    seen.add(option.id);
    models.push(option);
  }
  return { models, truncated };
}

function listing(
  status: SandEndpointModelListing["status"],
  endpoint: string,
  models: readonly SandEndpointModelOption[],
  truncated: boolean,
  reason: SandEndpointModelReason | null,
): SandEndpointModelListing {
  return { status, endpoint, models, truncated, reason };
}

async function readBody(response: Response): Promise<string> {
  try { return await response.text(); } catch { return ""; }
}

/**
 * Probes `{baseUrl}/models` with the stored key. Resolves with an
 * `unavailable` listing for every failure; it never rejects.
 */
export async function listSandEndpointModels(args: {
  readonly baseUrl: unknown;
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly limit?: number;
}): Promise<SandEndpointModelListing> {
  const target = sandEndpointModelProbeTarget(args.baseUrl);
  if (target === null) return listing("unavailable", "", [], false, "insecure-url");
  const apiKey = typeof args.apiKey === "string" ? args.apiKey.trim() : "";
  if (apiKey.length === 0) return listing("unavailable", target.report, [], false, "missing-credential");
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return listing("unavailable", target.report, [], false, "unsupported");
  const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : SAND_ENDPOINT_MODEL_LIST_TIMEOUT_MS;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : SAND_ENDPOINT_MODEL_LIST_LIMIT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(target.url, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    return listing("unavailable", target.report, [], false, controller.signal.aborted ? "timeout" : "network-error");
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) return listing("unavailable", target.report, [], false, "unauthorized");
  if (!response.ok) return listing("unavailable", target.report, [], false, "http-status");
  let payload: unknown;
  try { payload = JSON.parse(await readBody(response)) as unknown; }
  catch { return listing("unavailable", target.report, [], false, "invalid-response"); }
  const parsed = parseSandEndpointModelPayload(payload, apiKey, limit);
  if (parsed === null) return listing("unavailable", target.report, [], false, "invalid-response");
  if (parsed.models.length === 0) return listing("unavailable", target.report, [], parsed.truncated, "no-models");
  return listing("ok", target.report, parsed.models, parsed.truncated, null);
}