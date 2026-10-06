// ---------------------------------------------------------------------------
// What the provider already said about its own refusal.
//
// `agent-run-error.ts` and `turn-runtime.ts` both turned every HTTP 400 and every 422 into
// one sentence, and that sentence told the user the conversation was probably too long. A
// box whose model id was wrong produced this measured line in `store.db`, five times in a
// row, while the provider's answer sat unread on the error:
//
//   The model provider refused the request (HTTP 400). The provider rejected the request
//   itself. A shorter conversation or a different model usually helps.
//
// The provider had said `Model space-bunny-free is not supported`. The conversation was 116
// entries and 0.2 MB; its length was never the cause. So the advice was wrong on both
// counts, and it was wrong because of the next paragraph.
//
// The reason was never missing. `createJsonErrorResponseHandler`
// (`@ai-sdk/provider-utils` 2.2.8, `index.js:709-761`) builds the `APICallError` with the
// parsed body on `data`, the raw text on `responseBody` and `message = errorToMessage(...)`;
// `streamText` enqueues that same object as a `{ type: "error" }` part
// (`ai` 4.3.17, `index.mjs:3674`), `tool-stream-executor.ts:1223` rethrows it and
// `abstract-user-message-action-handler.ts:1783` rethrows it again. Measured against a local
// endpoint answering 400, the object that reaches `describeAgentRunError` carries
// `responseBody`, `data`, `statusCode` and the provider's sentence. Nothing in the chain
// drops the body. Two descriptions then declined to read it, each saying so in a comment,
// because copying text off a wire-shaped error was believed to be a leak waiting to happen.
//
// Copying it wholesale would be that leak: the same error also carries
// `requestBodyValues` — the whole prompt — and a provider that echoes a refusal quotes the
// credential back at the client. So this module is deliberately NOT a copy-out of `message`.
//
// The rule instead: never echo provider prose, and quote only a token.
//
//  - Provider prose can carry anything. It is untrusted data, it is not a sentence this build
//    wrote, and rendering it verbatim would let a provider — or anyone who can make a
//    provider — put words in the user's mouth inside a tray that reads like an instruction.
//    So the only provider-controlled strings that can reach a user are the model id and the
//    provider's own error code, and both are validated against a charset with no whitespace,
//    no quotes, no angle brackets and no braces before either is used.
//  - Those two tokens are the whole leak surface, and they are the two places a secret can
//    actually land: a user who pastes their API key into the model field gets it named back
//    by the provider. Both are refused when they match a credential shape.
//  - Everything else about the failure is said in this repository's own words, selected by
//    what the body names. A body that names no cause yields the generic sentence, which no
//    longer guesses at conversation length.
//
// Nothing here may raise. Both callers are reached from a `catch` whose job is to report why
// a turn died; a classifier that raises replaces the failure being classified.
// ---------------------------------------------------------------------------

/** The causes the provider can name in a 4xx body, each with its own sentence. */
export type ProviderRefusalKind =
  | "model_not_found"
  | "context_too_long"
  | "content_refused"
  | "credential_rejected";

export interface ProviderRefusal {
  readonly kind: ProviderRefusalKind;
  readonly httpStatus: number;
  /** The model the provider named, when it named one that is safe to repeat. */
  readonly modelId?: string;
  /** The provider's own machine code, when it sent one that is safe to repeat. */
  readonly providerCode?: string;
}

/** A budget, not a hope: `cause` chains can be deep and legal. */
const MAX_FAILURE_WALK_NODES = 512;

/**
 * A refused request body can be a whole echoed conversation, so it is truncated before
 * anything reads it. Only the head of a body carries the reason; the tail is the payload the
 * provider quoted back.
 */
const MAX_REASON_LENGTH = 4_096;

const MAX_IDENTIFIER_LENGTH = 64;

/**
 * No whitespace, no quotes, no braces, no angle brackets. A token that matches this cannot
 * carry a second sentence, a newline, a markdown link or a tag, so quoting one inside our
 * own sentence cannot turn into an instruction.
 */
const IDENTIFIER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,63}$/;

/**
 * Credential shapes refused before either token is used. Every provider key format in wide
 * use starts with one of these, and the fallback covers the rest: a key pasted into the model
 * field comes back named in the body, and that is the realistic way a key reaches this text.
 */
const CREDENTIAL_SHAPED_IDENTIFIER =
  /^(?:sk|ghp|gho|github_pat|xox[baprs]|AIza|AKIA|ASIA|eyJ)[-_.]|bearer|token|secret|passw|api[-_.]?key/i;

/**
 * The words that follow "model" in a refusal that is not naming a model: "Model is not
 * supported", "Model id unknown". Without this the sentence would quote the word "is".
 */
const NOT_A_MODEL_ID = new Set([
  "a", "an", "are", "as", "at", "be", "by", "can", "did", "do", "does", "exist", "exists",
  "for", "found", "given", "has", "have", "here", "id", "in", "invalid", "is", "it", "must",
  "name", "no", "not", "now", "only", "provided", "requested", "specified", "that", "the",
  "this", "to", "unavailable", "unknown", "unsupported", "was", "were", "with",
]);

/**
 * Each pattern is the provider naming one cause in its own words. `model_not_found` is split
 * in two because bare "not supported" also appears in refusals that are about something else,
 * so it only counts next to a mention of a model.
 */
const NAMES_MODEL = /\bmodels?\b|\bmodel[_ -]?id\b/i;
const NAMES_UNSUPPORTED =
  /not supported|does not exist|doesn't exist|no such model|unknown model|unsupported model|invalid model|model[_ -]?not[_ -]?found|is not available/i;
const NAMES_CONTEXT =
  /context[_ -]?length|context window|maximum context|context[_ -]?exceeded|too many tokens|max(?:imum)?[_ -]?tokens|token limit|input length|prompt is too long|reduce the (?:number of )?tokens|request (?:was )?too large/i;
const NAMES_CONTENT =
  /content[_ -]?policy|content[_ -]?filter|moderation|flagged|prohibited content|responsible ai|content management|violat(?:es|ion)|nsfw/i;
const NAMES_CREDENTIAL =
  /api[_ -]?key|unauthori[sz]ed|authentication|invalid[_ -]?token|token (?:is|has) (?:invalid|expired|missing)|missing (?:api )?key|no api key|credential/i;

/** `"model <id>"`, or `model id <id>`, in either case. */
const MODEL_TOKEN = /\bmodels?\s+(?:id\s+|name\s+)?["'“]?([A-Za-z0-9][A-Za-z0-9._:/+\-]{0,63})/i;
/** `"<id>"`, for a provider that quotes the model instead of prefixing it. */
const QUOTED_TOKEN = /["'“]([A-Za-z0-9][A-Za-z0-9._:/+\-]{0,63})["'”]/;
/** `SAND-E0407`, `model_not_found`, `context_length_exceeded`. */
const CODE_TOKEN = /\b([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+)\b/;

/** Property reads are attacker-shaped: a getter can throw, and one did. */
function readProperty(value: unknown, name: string): unknown {
  if (value == null || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

function walkFailureNodes(
  error: unknown,
  visit: (node: Record<string, unknown>) => void,
): void {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  let budget = MAX_FAILURE_WALK_NODES;
  while (stack.length > 0 && budget > 0) {
    const current = stack.pop();
    if (current == null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    budget -= 1;
    visit(current as Record<string, unknown>);
    stack.push(readProperty(current, "cause"));
    const inners = readProperty(current, "errors");
    if (Array.isArray(inners)) for (const inner of inners) stack.push(inner);
  }
}

/** A provider's id, or nothing. Never anything that could be a credential. */
function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  if (token.length < 2 || token.length > MAX_IDENTIFIER_LENGTH) return undefined;
  if (!IDENTIFIER_TOKEN.test(token)) return undefined;
  if (CREDENTIAL_SHAPED_IDENTIFIER.test(token)) return undefined;
  return token;
}

function statusOf(node: Record<string, unknown>): number | undefined {
  const raw = readProperty(node, "statusCode") ?? readProperty(node, "status");
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/**
 * The HTTP status anywhere in a failure, or `undefined` when the failure carries none.
 *
 * Exported so the demotion trigger can ask "was this a request-level refusal at all?" without a
 * second copy of the `cause`/`errors[]` walk. Two copies of a traversal that decides whether a
 * network probe runs would drift, and the copy that drifted would either probe on a rate limit or
 * skip the refusal the catalogue exists to catch.
 */
export function providerFailureHttpStatus(error: unknown): number | undefined {
  let status: number | undefined;
  walkFailureNodes(error, (node) => {
    status ??= statusOf(node);
  });
  return status;
}

/**
 * The sentence a provider body carries, from the parsed shape first and the raw text second.
 *
 * Four shapes cover what OpenAI-compatible endpoints answer with: `{error:{message}}`,
 * `{error:"text"}`, `{message}` and FastAPI's `{detail}` (string, or a list of `{msg}`).
 * `data` is preferred over `responseBody` because the SDK has already parsed it.
 */
function reasonFromParsedBody(body: unknown): { readonly message?: string; readonly code?: string } {
  if (typeof body === "string") return { message: body };
  if (body == null || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const error = readProperty(record, "error");
  const detail = readProperty(record, "detail");
  const fromDetail = Array.isArray(detail) ? readProperty(detail[0], "msg") : detail;
  const message =
    readProperty(error, "message") ??
    (typeof error === "string" ? error : undefined) ??
    readProperty(record, "message") ??
    (typeof fromDetail === "string" ? fromDetail : undefined);
  const code =
    readProperty(error, "code") ??
    readProperty(record, "code") ??
    readProperty(record, "error_code") ??
    readProperty(error, "error_code");
  return { ...(typeof message === "string" ? { message } : {}), ...(typeof code === "string" || typeof code === "number" ? { code: String(code) } : {}) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The reason text and machine code on one node, or nothing. A node only counts when it is
 * wire-shaped, so this never reads a sentence this repository wrote.
 */
function reasonOf(node: Record<string, unknown>): { readonly message: string; readonly code?: string } | undefined {
  const parsed = reasonFromParsedBody(readProperty(node, "data"));
  let message = typeof parsed.message === "string" ? parsed.message : undefined;
  let code = parsed.code;
  if (message == null) {
    const raw = readProperty(node, "responseBody");
    if (typeof raw === "string" && raw.trim() !== "") {
      const bounded = raw.length > MAX_REASON_LENGTH ? raw.slice(0, MAX_REASON_LENGTH) : raw;
      const fromBody = reasonFromParsedBody(parseJson(bounded));
      message = fromBody.message ?? bounded;
      code ??= fromBody.code;
    }
  }
  if (message == null) return undefined;
  const bounded = message.length > MAX_REASON_LENGTH ? message.slice(0, MAX_REASON_LENGTH) : message;
  return { message: bounded, ...(code === undefined ? {} : { code }) };
}

function kindOf(reason: string): ProviderRefusalKind | undefined {
  const namesModel = NAMES_MODEL.test(reason);
  if (namesModel && NAMES_UNSUPPORTED.test(reason)) return "model_not_found";
  if (NAMES_CONTEXT.test(reason)) return "context_too_long";
  if (NAMES_CONTENT.test(reason)) return "content_refused";
  if (NAMES_CREDENTIAL.test(reason)) return "credential_rejected";
  return undefined;
}

/** The model a `model_not_found` body named, when the words around it are not the model. */
function modelIdOf(reason: string): string | undefined {
  for (const pattern of [MODEL_TOKEN, QUOTED_TOKEN]) {
    const matched = safeIdentifier(pattern.exec(reason)?.[1]);
    if (matched != null && !NOT_A_MODEL_ID.has(matched.toLowerCase())) return matched;
  }
  return undefined;
}

function providerCodeOf(source: { readonly code?: string }, reason: string): string | undefined {
  return safeIdentifier(source.code) ?? safeIdentifier(CODE_TOKEN.exec(reason)?.[1]);
}

/**
 * What the provider's own body said, including when it said something this build cannot use.
 *
 * `refusal` is the classified cause, present only when the body named one. `namedSomething` is the
 * weaker fact that the body was READ and carried a reason this build recognises as provider prose —
 * a context limit, a content rule, a key complaint, or an unclassifiable sentence. `read` says a body
 * was legible at all.
 *
 * The distinction exists for one caller. The demotion trigger asks the endpoint's model catalogue
 * only when the body explained NOTHING, because a body that explained itself is evidence in its own
 * right and a catalogue probe is not free. `namedSomething` is what makes that decision possible
 * without a second parser and without weakening `providerRefusalOf`, whose contract is unchanged.
 */
export interface ProviderRefusalReading {
  readonly refusal?: ProviderRefusal;
  readonly namedSomething: boolean;
}

const NOTHING_READ: ProviderRefusalReading = { namedSomething: false };

/**
 * The cause the provider named for this failure, or `undefined` when it named none.
 *
 * The status is required: both callers gate on 400/422 already, and a sentence that cannot
 * name the status it is answering is worse than the generic one.
 */
export function providerRefusalOf(error: unknown): ProviderRefusal | undefined {
  return readProviderRefusal(error).refusal;
}

/**
 * The full reading of a failure body: the cause when there is one, and whether the body said
 * anything at all.
 */
export function readProviderRefusal(error: unknown): ProviderRefusalReading {
  try {
    let status: number | undefined;
    let reason: { readonly message: string; readonly code?: string } | undefined;
    walkFailureNodes(error, (node) => {
      status ??= statusOf(node);
      if (reason != null) return;
      const candidate = reasonOf(node);
      if (candidate != null) {
        reason = candidate;
        status ??= statusOf(node);
      }
    });
    if (reason == null) return NOTHING_READ;
    const kind = kindOf(reason.message);
    const httpStatus = status ?? 0;
    const readable = httpStatus >= 400 && httpStatus <= 499;
    // A sentence this build cannot classify is NOT an explanation, and saying it was is what kept
    // the spare model unused. Measured live: a model id the endpoint did not serve produced a 400
    // whose body the classifier could not read; this branch reported `namedSomething: true`, the
    // consumer read that as "the body already explained itself", the endpoint catalogue was never
    // asked, and the route stayed on the broken model. The module's own comment above the consumer
    // already promised the opposite — that an unreadable sentence leaves the catalogue as the only
    // signal. Only a cause we actually classified counts as something named.
    if (kind == null) return NOTHING_READ;
    if (!readable) return { namedSomething: true };
    const modelId = kind === "model_not_found" ? modelIdOf(reason.message) : undefined;
    const providerCode = providerCodeOf(reason, reason.message);
    return {
      namedSomething: true,
      refusal: {
        kind,
        httpStatus,
        ...(modelId === undefined ? {} : { modelId }),
        ...(providerCode === undefined ? {} : { providerCode }),
      },
    };
  } catch {
    return NOTHING_READ;
  }
}

function statusSuffix(refusal: ProviderRefusal): string {
  return refusal.providerCode === undefined
    ? `HTTP ${refusal.httpStatus}`
    : `HTTP ${refusal.httpStatus}, provider code ${refusal.providerCode}`;
}

/** The half a transcript notice prints as its title. */
export function providerRefusalTitle(refusal: ProviderRefusal): string {
  switch (refusal.kind) {
    case "model_not_found":
      return `The model provider does not have that model (${statusSuffix(refusal)}).`;
    case "credential_rejected":
      return `The model provider rejected the API key (${statusSuffix(refusal)}).`;
    case "context_too_long":
      return `This conversation no longer fits the model's context window (${statusSuffix(refusal)}).`;
    case "content_refused":
      return `The model provider refused the content of this turn (${statusSuffix(refusal)}).`;
  }
}

/** The half that tells the user what to do. */
export function providerRefusalDetail(refusal: ProviderRefusal): string {
  switch (refusal.kind) {
    case "model_not_found":
      return refusal.modelId === undefined
        ? 'The provider refused the request because of the model id and gave no other reason. Fix the model id in Settings → Router, or point Settings → Router at a provider that serves it.'
        : `The provider refused the request because the model id "${refusal.modelId}" is not one it serves. Fix the model id in Settings → Router, or point Settings → Router at a provider that serves it.`;
    case "credential_rejected":
      return "The provider answered that the key is missing, wrong or expired. Fix the key in Settings → Router. The key itself is not shown here.";
    case "context_too_long":
      return "The provider counted the request and refused it, so this is a real size limit and not a guess. Start a new chat, or ask the agent to summarise the earlier turns before continuing.";
    case "content_refused":
      return "A content rule on the provider's side matched something in the conversation. Reword or remove that part and send the message again.";
  }
}

/** One sentence for the error tray, which has a `detail` and no title of its own. */
export function providerRefusalSentence(refusal: ProviderRefusal): string {
  return `${providerRefusalTitle(refusal)} ${providerRefusalDetail(refusal)}`;
}

/**
 * The 400/422 sentence for a body that named no cause.
 *
 * The old wording told the user a shorter conversation usually helps, which is one guess
 * among several and was measured wrong on a box whose model id did not exist. This says what
 * is actually known: the provider refused, and did not say why.
 */
export function providerRefusalFallbackTitle(status: number): string {
  return `The model provider refused the request (HTTP ${status}).`;
}

export function providerRefusalFallbackDetail(): string {
  return "The provider gave no reason. Sending the message again usually works; if it keeps failing, check the base URL and the model id in Settings → Router.";
}