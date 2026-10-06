import {
  activeCustomModelDemotion,
  isSandEndpointModelId,
  type SandInferenceCustomEndpoint,
  type SandInferenceCustomModelDemotion,
  type SandInferenceCustomModelDemotionReason,
  type SandInferenceProvider,
} from "../../../shared/inference-router.js";
import type { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { providerFailureHttpStatus, providerRefusalOf, readProviderRefusal } from "../transcript/provider-refusal-reason.js";
import {
  probeEndpointCatalogue,
  type SandEndpointCatalogueVerdict,
} from "./endpoint-model-catalogue.js";

// ---------------------------------------------------------------------------
// When one failed turn is allowed to move the whole route onto the spare model.
//
// The request: "if the primary model fails once with an error, ALL SUBSEQUENT requests go to
// DeepSeek". That is a sticky demotion, not a retry, so the one thing this module must not do is
// demote on a failure that says nothing about the model. A rate limit, a 500, a dropped socket and
// a context overflow all look like "an error" to a user reading a tray, and demoting on any of them
// would silently move someone off the model they chose because the provider was busy for a minute.
//
// There are two signals, and the FIRST one is the endpoint's own model catalogue.
//
//   PRIMARY — the catalogue. `GET <baseUrl>/models` is the provider listing the ids it serves, and
//   it is reachable with no credential on the provider this feature was built for (measured: 43
//   entries at `https://opencode.ai/zen/go/v1/models`, identical with and without an
//   `authorization` header). When the catalogue answers and the primary model id is not in it, the
//   model does not exist there and the route moves. This signal cannot be fooled by a provider that
//   invents wording, omits wording, or answers an error with no body: it is the same document the
//   Router panel fills its dropdown from.
//
//   Why it is primary, measured: the classifier below needs the provider's refusal SENTENCE to
//   arrive on the error object, and two reachable live shapes erase it before anything can read it.
//   A 400 whose body is empty leaves `APICallError.message = "Bad Request"` and
//   `responseBody = ""`; a 400 whose body is not JSON leaves `data` undefined. Both produce the
//   generic notice and neither can be classified. A 200 status carrying an error frame in its body
//   loses the status as well, so not even a 4xx check can see it. The catalogue is the only signal
//   that survives all of them.
//
//   SECONDARY — the prose classifier. `providerRefusalOf` must classify the failure as
//   `model_not_found`. That kind needs TWO independent signals in the provider's own body — a
//   mention of a model AND a phrase that says it is unsupported (`provider-refusal-reason.ts`,
//   `kindOf`) — and that module refuses to return any kind at all unless the status is a 4xx it can
//   name. It is kept for the endpoints whose catalogue is unreachable but whose refusal text is
//   legible, and it is consulted only when the catalogue said nothing.
//   - the status must be 400 or 422, checked again here. A 429 and a 500 carry a status that cannot
//     reach this function, whatever their body says; `429 Too Many Requests: model is not supported`
//     and `500 unknown model` are both refused below, and both are real bodies providers send.
//   - the identifier the provider named must BE the primary model this endpoint is configured with.
//     "Mentions a model and says not supported" is not enough, and that is the third signal this
//     module used to be missing. OpenAI-compatible providers refuse a single capability in exactly
//     that shape, and every one of these was measured classifying as `model_not_found` and retiring
//     a model that was fine:
//
//       Invalid parameter: 'response_format' is not supported with this model
//       Invalid value: 'image_url' is not supported with this model
//       tools is not supported with this model
//
//     `tools` is sent on every turn this app makes, so the last one is not hypothetical. The model
//     named by a capability refusal is the parameter — `response_format`, `image_url`, sometimes
//     nothing at all — and the model that actually failed is never one of those.
//
// Everything else — `credential_rejected`, `context_too_long`, `content_refused`, no classification
// at all, any non-4xx, a `model_not_found` that never says which model, and a catalogue that did not
// answer — leaves the route exactly as the user set it, and the turn simply reports what happened. A
// signal that cannot name the model is deliberately NOT enough to demote: the cost of leaving a
// genuinely broken model in place is one more failed turn the user can read, and the cost of
// demoting wrongly is a silent move off the model they chose. When in doubt, do not demote.
//
// The catalogue's third answer is the reason this is safe. `unknown` — timeout, 5xx, non-JSON,
// redirect, refused URL, empty id — is not evidence of absence, so it falls through to the
// classifier and, if that says nothing too, the route stays. A bad minute on the network must never
// move a user off their model.
// ---------------------------------------------------------------------------

/** The statuses a request-level refusal uses. A 429 and a 5xx are not among them, by design. */
const DEMOTION_STATUSES: ReadonlySet<number> = new Set([400, 422]);

export interface CustomModelDemotionInput {
  readonly inferenceProvider: SandInferenceProvider;
  readonly endpoint: SandInferenceCustomEndpoint;
  readonly demotion: unknown;
  /** The failure one turn died on, exactly as it was thrown. */
  readonly error: unknown;
  /**
   * What the endpoint's own `/models` catalogue said about the primary model id.
   *
   * `undefined` means the question was never asked, and is treated exactly like `unknown`: the
   * classifier is consulted and, failing that, nothing happens. A caller that cannot reach the
   * catalogue therefore keeps the pre-catalogue behaviour rather than gaining a new way to demote.
   */
  readonly catalogueVerdict?: SandEndpointCatalogueVerdict;
  /** Injected so a test can fix the clock; the record's timestamp is not read by any decision. */
  readonly now?: () => Date;
}

/**
 * What the trigger concluded about one failed turn.
 *
 * `demotion` is the record in force afterwards, whether this failure wrote it or an earlier one
 * did; `recorded` says which. A caller that tells the user "you are on the spare now" needs both:
 * announcing only the turn that flipped the route would leave every later turn silent about why it
 * is on a model the user did not pick.
 *
 * `basis` is which signal decided, and it exists for one caller: `applyCustomModelDemotionForFailure`
 * asks the endpoint's catalogue only when the failure's own sentence did NOT already decide. Asking
 * a network question on the failure path of every turn would put a probe on cases the prose already
 * answers, and the whole point of the catalogue is to cover the cases the prose cannot.
 */
export interface CustomModelDemotionOutcome {
  readonly demotion?: SandInferenceCustomModelDemotion;
  readonly recorded: boolean;
  readonly basis?: "catalogue" | "prose";
}

const NO_DEMOTION: CustomModelDemotionOutcome = { recorded: false };

/**
 * The demotion this failure justifies, or nothing when it justifies none.
 *
 * A pure function of the failure, the stored record and the catalogue's verdict: no clock, no store
 * and no network, so it is the only place the demotion rule lives and it can be driven directly.
 * `applyCustomModelDemotionForFailure` asks the catalogue, calls this, and writes what it returns;
 * `provider-session.ts` reads the result back through `activeCustomModelDemotion`.
 */
export function customModelDemotionForFailure(
  input: CustomModelDemotionInput,
): CustomModelDemotionOutcome {
  try {
    // The spare is a property of the custom OpenAI-compatible route. No other provider has one, and
    // reading another provider's endpoint would demote a route that never used it.
    if (input.inferenceProvider !== "custom") return NO_DEMOTION;
    // The spare must be an id this build can put on the wire. An endpoint reached through
    // `resolveEffectiveCustomModelId` is already guarded, but this function is also called with an
    // endpoint a test or a future caller assembled, and a check here is what makes "never demote to a
    // model id that cannot be sent" a property of this function rather than of its callers.
    if (!isSandEndpointModelId(input.endpoint.fallbackModelId)) return NO_DEMOTION;
    const fallbackModelId = input.endpoint.fallbackModelId.trim();
    // A route with no spare has nothing to be demoted TO. This is what keeps every existing
    // settings file behaving exactly as it did before the field existed.
    if (fallbackModelId.length === 0) return NO_DEMOTION;
    if (fallbackModelId === input.endpoint.modelId.trim()) return NO_DEMOTION;
    // A demotion already in force is the answer, and this failure must not rewrite it: a fresh
    // timestamp on every later failing turn would claim a demotion that happened long ago.
    const active = activeCustomModelDemotion(input.endpoint, input.demotion);
    if (active !== undefined) return { demotion: active, recorded: false };

    // The primary signal. The endpoint listed the ids it serves and the one this route is
    // configured to send was not among them. No sentence has to survive anything for this to hold,
    // which is the whole point: the shapes that erase a provider's refusal text cannot erase its
    // catalogue. `present` and `unknown` both fall through — `present` because the model exists, and
    // `unknown` because "the endpoint did not answer" is not evidence that a model is gone.
    if (input.catalogueVerdict === "absent")
      return {
        ...demoted(input.endpoint, fallbackModelId, "model_absent_from_catalogue", 0, input.now),
        basis: "catalogue",
      };

    // The secondary signal, for an endpoint whose catalogue could not be read. The classifier needs
    // the provider's own sentence on the error object, so this is deliberately the weaker of the
    // two and is unreachable whenever the catalogue answered `absent`.
    const refusal = providerRefusalOf(input.error);
    if (refusal === undefined || refusal.kind !== "model_not_found") return NO_DEMOTION;
    // `providerRefusalOf` can classify a 429 — it is a 4xx — and it deliberately does. The status set
    // is enforced here instead, so `429 Too Many Requests: model is not supported` is refused with the
    // two statuses a request-level refusal actually uses. A 5xx never reaches this line at all,
    // because the classifier names no kind outside 4xx.
    if (refusal.httpStatus !== 400 && refusal.httpStatus !== 422) return NO_DEMOTION;
    // The strong signal on this path, and the only one that separates "my model is gone" from "this
    // model will not do that one thing": the provider must have named the model we actually sent.
    // See the header: a named parameter such as `response_format`, `image_url` or `tools` is not a
    // model, and a refusal that names no model at all is not a demotion either.
    const named = refusal.modelId?.trim();
    if (named === undefined || named.length === 0) return NO_DEMOTION;
    if (named.toLowerCase() !== input.endpoint.modelId.trim().toLowerCase()) return NO_DEMOTION;
    return {
      ...demoted(input.endpoint, fallbackModelId, "model_not_found", refusal.httpStatus, input.now),
      basis: "prose",
    };
  } catch {
    // This runs inside the catch that is reporting why a turn died. A throw here would replace the
    // provider's failure with a failure of this function, and the user would be told nothing.
    return NO_DEMOTION;
  }
}

/** The one place a demotion record is built, so both signals write the same shape. */
function demoted(
  endpoint: SandInferenceCustomEndpoint,
  toModelId: string,
  reason: SandInferenceCustomModelDemotionReason,
  httpStatus: number,
  now: (() => Date) | undefined,
): CustomModelDemotionOutcome {
  return {
    recorded: true,
    demotion: {
      fromModelId: endpoint.modelId.trim(),
      toModelId,
      reason,
      httpStatus,
      at: (now?.() ?? new Date()).toISOString(),
    },
  };
}

/**
 * Records the sticky demotion a failed turn justifies, through the settings file the rest of the
 * app reads, and reports the demotion now in force.
 *
 * This is the production entry point, and the only place the catalogue is asked. The order matters:
 * the failure's own sentence is classified FIRST, and the endpoint's catalogue is asked only when
 * that sentence decided nothing. Two reasons:
 *
 *  - The catalogue covers exactly the cases the prose cannot. When a provider answers 400 with an
 *    empty body — measured live, and the reason this feature did not work — there is no sentence to
 *    classify, and the catalogue is the only signal left. When the prose already proves the model is
 *    gone there is nothing for the catalogue to add.
 *  - It keeps a network probe off the failure path of the failures the prose handles, so a 429, a
 *    500 and a reset never wait on a socket that has nothing to say about them.
 *
 * The probe is awaited when it runs, so it delays a failure report by at most
 * `SAND_ENDPOINT_CATALOGUE_TIMEOUT_MS`. That is bounded on purpose — the turn has already failed, the
 * user is owed an explanation either way, and a probe that hangs must not hold the transcript write
 * open. `probe` is injected so a test can drive the catalogue without a socket.
 *
 * It never throws — reporting a failed turn must not create a second failure — and it never writes
 * when the answer is already on disk, so a route that keeps failing cannot churn the file.
 */
export async function applyCustomModelDemotionForFailure(
  store: SandSettingsStore,
  error: unknown,
  probe: typeof probeEndpointCatalogue = probeEndpointCatalogue,
): Promise<CustomModelDemotionOutcome> {
  try {
    const endpoint = store.getInferenceCustomEndpoint();
    if (endpoint === undefined) return NO_DEMOTION;
    const inferenceProvider = store.getInferenceProvider();
    const demotion = store.getInferenceCustomModelDemotion();
    const write = (outcome: CustomModelDemotionOutcome): CustomModelDemotionOutcome => {
      if (outcome.demotion !== undefined && outcome.recorded)
        store.setInferenceCustomModelDemotion(outcome.demotion);
      return outcome;
    };
    // The sentence first. `catalogueVerdict` is deliberately left unset, so this is exactly the
    // pre-catalogue decision; `basis === "prose"` means it already decided and the catalogue is moot.
    const fromProse = customModelDemotionForFailure({ inferenceProvider, endpoint, demotion, error });
    // A demotion already in force is also an answer: the route is on the spare, and re-deciding it
    // would rewrite the timestamp of a demotion that happened long ago.
    if (fromProse.basis === "prose" || fromProse.demotion !== undefined) return write(fromProse);
    // Only the custom route has a spare, and only an endpoint that declares one can act on the
    // catalogue's answer. Any other failure must not put a request on the wire.
    if (inferenceProvider !== "custom") return fromProse;
    if (!isSandEndpointModelId(endpoint.fallbackModelId)) return fromProse;
    // The catalogue is asked ONLY when the failure is a request-level refusal AND its body explained
    // nothing. Both halves matter.
    //
    // "Request-level refusal" is what "the model id is wrong" looks like on the wire, and it is a
    // whitelist on purpose: a 429, a 5xx, a 401, a dropped socket, a first-token stall, a context
    // overflow, an abort and a failure with no status at all must NOT cause an outbound request. A
    // rate-limited provider that gets a second request from this app for every failed turn is being
    // made worse by the code that is supposed to help.
    //
    // "Explained nothing" is the half that keeps the probe off failures that already said what they
    // were. A body that named a context limit, a content rule or a key problem is evidence in its own
    // right, and the catalogue cannot overturn it; only a body with no legible reason at all — an
    // empty one, an HTML one, a sentence this build cannot classify — leaves the catalogue as the
    // only signal left. That is exactly the production shape: measured live, a 400 whose
    // `responseBody` was `""` and whose message was the bare status text "Bad Request".
    //
    // Coverage is not lost by the wait. A model the endpoint does not serve fails every turn, so the
    // next attempt presents the same unreadable refusal, and the catalogue is asked then.
    if (!isRequestLevelRefusal(error)) return fromProse;
    if (readProviderRefusal(error).namedSomething) return fromProse;
    const { verdict } = await probe({ baseUrl: endpoint.baseUrl, modelId: endpoint.modelId });
    if (verdict !== "absent") return fromProse;
    return write(customModelDemotionForFailure({
      inferenceProvider,
      endpoint,
      demotion,
      error,
      catalogueVerdict: verdict,
    }));
  } catch {
    return NO_DEMOTION;
  }
}

/**
 * True when a failure is a request-level refusal: the provider answered THIS request with 400 or
 * 422. That is the only class the catalogue may be asked about.
 *
 * The status is read through the classifier's own traversal, so the `cause`/`errors[]` walk that
 * names a status everywhere else names it here too; a status nested inside a wrapper must be found
 * here, or the catalogue would be skipped on the very failure it exists to catch.
 */
function isRequestLevelRefusal(error: unknown): boolean {
  const status = providerFailureHttpStatus(error);
  return status === 400 || status === 422;
}
