/**
 * An unauthenticated probe of an OpenAI-compatible endpoint's own model catalogue.
 *
 * `GET <baseUrl>/models` is what the Router panel already reads to fill its model dropdown
 * (`inference-endpoint-models.ts`), and the answer is the provider's own ground truth for whether a
 * model id exists. For the OpenCode Zen endpoint this document is reachable with no credential at
 * all: measured, `GET https://opencode.ai/zen/go/v1/models` answers `200 application/json` with 43
 * entries, and answers identically with no `authorization` header and with a garbage one.
 *
 * That is the signal the demotion needed. The prose classifier in `provider-refusal-reason.ts`
 * decides nothing unless the provider's refusal text arrives intact on the error object, and it
 * measured arriving intact on the 400-with-a-JSON-body path — but two reachable live shapes erase it
 * before the classifier can see it, and both were measured here:
 *
 *  - a 400 whose body is empty (`APICallError.message` becomes the HTTP status text "Bad Request",
 *    `responseBody` becomes `""`), and
 *  - a 400 whose body is not JSON at all.
 *
 * Neither leaves one word of the provider's sentence, so no parser of that sentence can demote. The
 * catalogue does not depend on the failure body existing, being JSON, or being in English. It
 * answers the question the demotion actually asks — "does this endpoint serve the model id we are
 * about to send?" — and it answers it before trusting any prose.
 *
 * Why this module and not `listSandEndpointModels`: that function refuses to reach the network when
 * no credential is configured, and answers `missing-credential` instead (`:178`), because the Router
 * panel must never probe without the key the user stored. That rule is pinned by a test and is right
 * for the panel. A /models probe that carries no credential is a different call with a different
 * contract, so it is a different function rather than a loosened one.
 *
 * Credentials are never sent. Nothing here reads, stores or logs a key, and the only value this
 * module returns is a list of model ids — the same public document the panel already shows.
 */

import { sandEndpointModelProbeTarget } from "../../../shared/node/inference-endpoint-models.js";

/** Matches the panel's probe budget. A slow catalogue must not hold a failing turn open. */
export const SAND_ENDPOINT_CATALOGUE_TIMEOUT_MS = 5_000;

/** A catalogue larger than this is not a model list this build will reason about. */
export const SAND_ENDPOINT_CATALOGUE_LIMIT = 2_000;

const SAND_ENDPOINT_CATALOGUE_ID_MAX = 200;

/**
 * What the endpoint's own catalogue said about the model id this route is configured to send.
 *
 * `absent` is the ONLY verdict that may ever demote. It means the probe reached the endpoint and the
 * endpoint returned a well-formed list that does not contain the id. `present` is the opposite.
 * `unknown` is every other outcome — no list, a 4xx, a 5xx, a timeout, a connection reset, a
 * redirect, a body that is not JSON, an empty list — and it deliberately decides NOTHING rather than
 * guessing, because "the endpoint did not answer" is the exact condition under which moving the user
 * off their chosen model would be a guess.
 */
export type SandEndpointCatalogueVerdict = "absent" | "present" | "unknown";

export interface SandEndpointCatalogueResult {
  readonly verdict: SandEndpointCatalogueVerdict;
  /** The probed URL with credentials, query and fragment removed. Never a credential. */
  readonly endpoint: string;
  readonly models: readonly string[];
}

function unknown(endpoint: string): SandEndpointCatalogueResult {
  return { verdict: "unknown", endpoint, models: [] };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The ids in one `{ object: "list", data: [{ id }] }` document.
 *
 * `null` means "this is not the document", which is the only case that may not be treated as an
 * empty catalogue: an endpoint that answers 200 with something else has told us nothing, and
 * reading it as "the model is absent" would demote on a malformed reply. An empty `data` array is a
 * real answer and yields `[]`.
 */
export function catalogueModelIds(payload: unknown): readonly string[] | null {
  const body = record(payload);
  if (body === null) return null;
  const data = body["data"];
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    if (ids.length >= SAND_ENDPOINT_CATALOGUE_LIMIT) break;
    let id: unknown;
    if (typeof entry === "string") id = entry;
    else {
      const model = record(entry);
      id = model === null ? undefined : model["id"] ?? model["model"];
    }
    if (typeof id !== "string") continue;
    // Control characters would let a catalogue entry forge a second line in anything that renders
    // one; the id charset the rest of this build uses has no whitespace either.
    const token = id.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
    if (token.length === 0 || token.length > SAND_ENDPOINT_CATALOGUE_ID_MAX) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    ids.push(token);
  }
  return ids;
}

/** Case-insensitive, exact: a catalogue is a set of ids, not a prefix tree. */
export function catalogueHasModelId(
  models: readonly string[],
  modelId: string,
): boolean {
  const wanted = modelId.trim().toLowerCase();
  if (wanted.length === 0) return false;
  for (const id of models) if (id.trim().toLowerCase() === wanted) return true;
  return false;
}

/**
 * Asks the endpoint whether it serves `modelId`, and returns the verdict.
 *
 * Never rejects and never throws: a probe that failed must not replace the provider failure it was
 * called to explain. A base URL the shared guard refuses (not https, or http off loopback) answers
 * `unknown` without any network call, so this cannot be pointed at an arbitrary host.
 */
export async function probeEndpointCatalogue(args: {
  readonly baseUrl: unknown;
  readonly modelId: unknown;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<SandEndpointCatalogueResult> {
  const target = sandEndpointModelProbeTarget(args.baseUrl);
  if (target === null) return unknown("");
  const modelId = typeof args.modelId === "string" ? args.modelId.trim() : "";
  if (modelId.length === 0) return unknown(target.report);
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return unknown(target.report);
  const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0
    ? args.timeoutMs
    : SAND_ENDPOINT_CATALOGUE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    // No `authorization`: measured unnecessary on this provider, and a credential must not be sent
    // to a URL this probe has only just re-validated.
    response = await fetchImpl(target.url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    return unknown(target.report);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return unknown(target.report);
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    return unknown(target.report);
  }
  const models = catalogueModelIds(payload);
  if (models === null) return unknown(target.report);
  return {
    verdict: catalogueHasModelId(models, modelId) ? "present" : "absent",
    endpoint: target.report,
    models,
  };
}
