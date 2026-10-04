import { ErrorDetails } from "../../../packages/proto/generated/aiserver/v1/utils_pb.js";
import {
  isContextOverflowDeadEnd,
  isConversationTooLargeRefusal,
  isFirstTokenStallError,
  isProviderCapacityError,
  isTransientStreamError,
} from "../../runner/transient-stream-error.js";

export const PROVIDER_OVERLOAD_ERROR_TITLE = "Model provider is overloaded";
export const PROVIDER_OVERLOAD_ERROR_DETAIL =
  "The model provider is under heavy load right now. This is usually temporary — retry, or switch to another model.";
export const SAND_INCLUDED_LIMIT_REASON = "sand_included_limit";
export const RESETS_AT_ABS_OR_ISO = /It resets at \S+\.?/g;
export const RESETS_IN_CLAUSE = /It resets in [^.]+/g;
export const MAX_TRAY_ACTIONS = 3;
export const CURSOR_WEBSITE_ORIGIN = "https://cursor.com";
export const SUPPORTED_DASHBOARD_ACTION_VERBS = new Set([
  "requestLimitIncrease",
]);

// ---------------------------------------------------------------------------
// Why the two fields below exist at all.
//
// `describeAgentRunError` returned `{title?, detail, actions?}` and nothing else, while two
// readers had already been written against two fields it never produced:
// `turn-runtime.ts` compares `description.errorKind` to a machine kind before it picks a tray
// title, and `automation-run-path.ts` reads both `errorKind` and `rawDetail` to decide whether
// it still owes the user its own sentence. The renderer does the same comparison
// (`index-lA9cgT4O.js`, the error tray component) and swaps in a friendlier sentence when it
// matches. Both branches were dead: the classifier knew the exact reason and the user was told
// that something broke.
//
// `errorKind` carries only kinds something acts on. A list nobody reads is not evidence that
// anything works, so the table below holds the two kinds with a real consumer: the renderer
// switches on the first, the tray title on the second. Wider classification shapes are
// reflected in the sentence, which every reader sees, rather than in a field nobody branches
// on.
// ---------------------------------------------------------------------------

/** The kind the renderer and the tray title switch on for a provider at capacity. */
export const PROVIDER_OVERLOADED_ERROR_KIND = "provider_overloaded";
/** A turn the user stopped. Not a crash, and reported as one by every generic sentence. */
export const USER_CANCELLED_ERROR_KIND = "user_cancelled";
export const TURN_CANCELLED_ERROR_TITLE = "Turn cancelled";
export const TURN_CANCELLED_ERROR_DETAIL =
  "You stopped this turn before the agent answered. Nothing is lost — send the message again when you want an answer.";
export const UNCLASSIFIED_RUN_ERROR_DETAIL =
  "The agent stopped without saying why. Sending the message again usually works.";

export interface BackendDetail {
  title?: string;
  detail?: string;
  buttons?: ErrorButton[];
  additionalInfo?: { rateLimitReason?: string; nextResetAt?: string };
}
export interface BackendConnectError extends Error {
  findDetails(type?: unknown): unknown;
  code?: number;
}

// ---------------------------------------------------------------------------
// Nothing in this file may raise.
//
// Every reader below is reached from a `catch` block whose job is to report why a turn died.
// An exception raised while classifying replaces the failure being classified with a failure
// that describes the classifier, and the user is left with no report at all. That is how a
// turn the user cancelled became indistinguishable from a crash: the report asked
// `ConnectError.findDetails()` a question the library cannot answer without a registry, and
// the answer was a `TypeError`.
// ---------------------------------------------------------------------------

/** Property reads are attacker-shaped: a getter can throw, and one did. */
function readProperty(value: unknown, name: string): unknown {
  if (value == null || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/**
 * A budget, not a hope. A cause chain 5000 deep is legal JavaScript and used to recurse until
 * the stack gave out; a cycle is bounded by `seen` but a chain is not.
 */
const MAX_FAILURE_WALK_NODES = 512;

function walkFailureNodes(
  error: unknown,
  visit: (node: Record<string, unknown>) => void,
): void {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  let budget = MAX_FAILURE_WALK_NODES;
  while (stack.length > 0 && budget > 0) {
    const current = stack.pop();
    if (current == null || typeof current !== "object" || seen.has(current))
      continue;
    seen.add(current);
    budget -= 1;
    visit(current as Record<string, unknown>);
    stack.push(readProperty(current, "cause"));
    const inners = readProperty(current, "errors");
    if (Array.isArray(inners)) for (const inner of inners) stack.push(inner);
  }
}

function isConnectError(value: unknown): value is BackendConnectError {
  return (
    value instanceof Error &&
    typeof (value as Partial<BackendConnectError>).findDetails === "function"
  );
}

/**
 * The registry `findDetails` requires, and the reason the old call could not work.
 *
 * `ConnectError.findDetails(typeOrRegistry)` runs `"typeName" in typeOrRegistry` before it
 * looks at the error's own details (`@connectrpc/connect` 1.x, `connect-error.js:92`), so the
 * argument is dereferenced first and `undefined` is a `TypeError`, not an empty result. It is
 * a `TypeError` for *every* `ConnectError`, with details or without: the call never reached
 * the error at all.
 */
function readBackendDetails(connectError: BackendConnectError): BackendDetail[] {
  try {
    const found = connectError.findDetails(ErrorDetails);
    if (Array.isArray(found) && found.length > 0) return backendDetailsOf(found);
  } catch {
    // A hostile or older `findDetails` is a missing detail, not a missing report.
  }
  // Details that were decoded in process (the stream-start timeout ConnectError is built with
  // `ErrorDetails` instances, not wire bytes) expose `.details` directly.
  return backendDetailsOf(readProperty(connectError, "details"));
}

function backendDetailsOf(value: unknown): BackendDetail[] {
  if (!Array.isArray(value)) return [];
  const details: BackendDetail[] = [];
  for (const entry of value) {
    const candidate = readProperty(entry, "details");
    if (candidate != null && typeof candidate === "object")
      details.push(candidate as BackendDetail);
  }
  return details;
}

export function walkForBackendConnectError(
  error: unknown,
  seen: Set<object>,
  first: { value: BackendConnectError | null },
): BackendConnectError | null {
  // Iterative, so a deep cause chain cannot exhaust the stack, and cycle-safe through `seen`.
  const stack: unknown[] = [error];
  let budget = MAX_FAILURE_WALK_NODES;
  while (stack.length > 0) {
    if (budget-- <= 0) return null;
    const current = stack.pop();
    if (current == null || typeof current !== "object" || seen.has(current))
      continue;
    seen.add(current);
    stack.push(readProperty(current, "cause"));
    const inners = readProperty(current, "errors");
    if (Array.isArray(inners)) for (const inner of inners) stack.push(inner);
    if (!isConnectError(current)) continue;
    if (readBackendDetails(current).length > 0) return current;
    first.value ??= current;
  }
  return null;
}

export function findBackendConnectError(
  error: unknown,
  requireDetails = true,
): BackendConnectError | null {
  const first = { value: null as BackendConnectError | null },
    detailed = walkForBackendConnectError(error, new Set(), first);
  return detailed ?? (requireDetails ? null : first.value);
}

export function getBackendErrorDetailMessage(error: unknown): string | null {
  const connectError = findBackendConnectError(error);
  const detail = connectError == null ? undefined : readBackendDetails(connectError)[0];
  const title = safeTrimmedText(readProperty(detail, "title")),
    message = safeTrimmedText(readProperty(detail, "detail"));
  return !title
    ? (message === "" ? null : message)
    : !message || message === title
      ? title
      : `${title}\n\n${message}`;
}

/**
 * The backend's own sentence, or the raw message. Kept for logs and telemetry text.
 *
 * Not for anything a user reads: the second half is `error.message`, which for a provider
 * refusal is the provider's own text. `describeAgentRunError` composes its own sentence
 * instead, and that is the only description that reaches a tray.
 */
export function formatAgentRunError(error: Error): string {
  return getBackendErrorDetailMessage(error) ?? error.message;
}

export function formatSandUsageResetIn(
  nextResetAt: string | Date,
  nowMs = Date.now(),
): string | null {
  // A number, a protobuf timestamp, or anything else the backend put there: `Date.parse` and
  // `.getTime()` both raise on the wrong type, and a relative "resets in …" is not worth a
  // throw.
  const resetMs =
    typeof nextResetAt === "string"
      ? Date.parse(nextResetAt)
      : nextResetAt instanceof Date
        ? nextResetAt.getTime()
        : Number.NaN;
  if (!Number.isFinite(resetMs)) return null;
  const ms = resetMs - nowMs;
  if (ms <= 0) return "less than a minute";
  if (ms >= 86_400_000) {
    const days = Math.ceil(ms / 86_400_000);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (ms >= 3_600_000) {
    const hours = Math.ceil(ms / 3_600_000);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function withRelativeSandIncludedLimitReset(
  detail: string,
  nextResetAt: string | null | undefined,
  nowMs = Date.now(),
): string {
  if (!nextResetAt) return detail;
  const relative = formatSandUsageResetIn(nextResetAt, nowMs);
  return relative == null
    ? detail
    : detail
        .replace(RESETS_AT_ABS_OR_ISO, `It resets in ${relative}.`)
        .replace(RESETS_IN_CLAUSE, `It resets in ${relative}`);
}

export type ErrorButton = {
  label?: string;
  action?: { case?: string; value?: any };
};
export function checkoutDeepControlUrl(action: {
  membershipToUpgradeTo?: string;
  allowTrial?: boolean;
}): string {
  const tier = ["pro", "pro_plus", "ultra"].includes(
    action.membershipToUpgradeTo ?? "",
  )
    ? action.membershipToUpgradeTo
    : "pro";
  let url = `${CURSOR_WEBSITE_ORIGIN}/api/auth/checkoutDeepControl?tier=${tier}`;
  if (action.allowTrial === true) url += "&allowTrial=true";
  else if (action.allowTrial === false) url += "&allowTrial=false";
  return url;
}

export function mapErrorDetailButtons(
  buttons: readonly ErrorButton[] | null | undefined,
): Array<Record<string, unknown>> {
  const actions: Array<Record<string, unknown>> = [];
  let hasSwitch = false;
  for (const button of Array.isArray(buttons) ? buttons : []) {
    // A button without an action, or with a null one, is what a truncated protobuf list
    // decodes to. It used to throw `Cannot read properties of null (reading 'value')`.
    if (actions.length >= MAX_TRAY_ACTIONS) break;
    const label = safeTrimmedText(readProperty(button, "label"));
    const action = readProperty(button, "action");
    const value = readProperty(action, "value") ?? {};
    switch (readProperty(action, "case")) {
      case "url":
        try {
          const url = new URL(readProperty(value, "url") as string);
          if (["http:", "https:"].includes(url.protocol) && label)
            actions.push({
              kind: "open-url",
              label,
              url: readProperty(value, "url"),
            });
        } catch {}
        break;
      case "upgrade":
        actions.push({
          kind: "open-url",
          label: label || "Upgrade",
          url: checkoutDeepControlUrl(value),
        });
        break;
      case "upgradeChoice":
        actions.push({
          kind: "open-url",
          label: label || "Upgrade",
          url: `${CURSOR_WEBSITE_ORIGIN}/pricing`,
        });
        break;
      case "switchModel":
        if (!hasSwitch) {
          hasSwitch = true;
          actions.push({ kind: "switch-model" });
        }
        break;
      case "dashboardAction": {
        const verb = readProperty(value, "action");
        const args = readProperty(value, "args");
        if (
          typeof verb === "string" &&
          SUPPORTED_DASHBOARD_ACTION_VERBS.has(verb) &&
          label
        )
          actions.push({
            kind: "dashboard-action",
            label,
            action: verb,
            ...(args != null && typeof args === "object"
              ? { args: { ...args } }
              : {}),
            successMessage: readProperty(value, "successMessage") || null,
          });
        break;
      }
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// What the user is allowed to read.
//
// The tray `detail` is printed by the renderer as a sentence. It used to be `error.message`,
// which for `APICallError` (ai 4.3.17) is the provider's own refusal text, and a provider that
// echoes the refusal quotes back the `Authorization` header, the `x-api-key` and the whole
// request. So the text below is composed from a closed table plus three bounded facts — an
// HTTP status, a `Retry-After` count and a machine kind — exactly the way
// `describeProviderTurnFailure` composes the transcript notice. `rawDetail` is backend
// authored too, so it goes through the same refusal test before it leaves.
// ---------------------------------------------------------------------------

const MAX_BACKEND_TEXT_LENGTH = 400;
const CREDENTIAL_SHAPED_TEXT =
  /authorization|proxy-authorization|\bcookie\b|\bbearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{8,}|\b(api[_ -]?key|secret|password|passphrase)\b\s*[:=]/i;

/**
 * Backend-authored text, refused outright when it carries a credential. Rejecting the whole
 * string rather than masking part of it keeps the invariant simple to state: nothing that
 * looked like a secret reaches a field, so nothing that looked like a secret can be read.
 */
function safeBackendText(value: unknown): string | undefined {
  const raw = safeTrimmedText(value);
  if (raw === "" || CREDENTIAL_SHAPED_TEXT.test(raw)) return undefined;
  const singleLine = raw
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (singleLine === "") return undefined;
  return singleLine.length > MAX_BACKEND_TEXT_LENGTH
    ? `${singleLine.slice(0, MAX_BACKEND_TEXT_LENGTH)}…`
    : singleLine;
}

function safeTrimmedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringOfUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value instanceof Error) return value.message;
  try {
    return String(value);
  } catch {
    // `Object.create(null)` and a broken `toString` both raise here, and neither is worth
    // losing the whole description over.
    return "";
  }
}

const USER_ABORT_MESSAGE = "User aborted request";
// `Code.Canceled` in `@connectrpc/connect`, i.e. 1.
const CANCELED_CONNECT_CODE = 1;

/**
 * Read straight off the error, never through `findDetails`: the one error that must never be
 * misreported is the one the user caused. `ConnectError` rewrites its own message
 * (`[canceled] User aborted request`) and keeps the original in `rawMessage`.
 */
export function isUserCancelledRun(error: unknown): boolean {
  let cancelled = false;
  walkFailureNodes(error, (node) => {
    if (cancelled) return;
    if (
      readProperty(node, "name") === "AbortError" ||
      readProperty(node, "message") === USER_ABORT_MESSAGE ||
      readProperty(node, "rawMessage") === USER_ABORT_MESSAGE ||
      (typeof readProperty(node, "findDetails") === "function" &&
        readProperty(node, "code") === CANCELED_CONNECT_CODE)
    )
      cancelled = true;
  });
  return cancelled;
}

/**
 * The same predicates `classifyAgentError` uses, so the tray and the telemetry cannot
 * disagree about why a turn died. They are reached through a guard because they read
 * properties directly and an arbitrary object is allowed to throw from a getter; a failure
 * here costs one classification, never the report itself.
 */
export function classifyAgentRunErrorKind(error: unknown): string | undefined {
  if (isUserCancelledRun(error)) return USER_CANCELLED_ERROR_KIND;
  try {
    if (isProviderCapacityError(error)) return PROVIDER_OVERLOADED_ERROR_KIND;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * The HTTP status a provider answered with. `APICallError` keeps it on `statusCode`; a couple
 * of transports spell it `status`. `turn-runtime.ts` carries the same reader for the transcript
 * notice; the two live in different layers and neither can import the other.
 */
function httpStatusOfFailure(error: unknown): number | undefined {
  let status: number | undefined;
  walkFailureNodes(error, (node) => {
    if (status !== undefined) return;
    const raw = readProperty(node, "statusCode") ?? readProperty(node, "status");
    const value = typeof raw === "number" ? raw : Number(raw);
    if (Number.isInteger(value) && value >= 100 && value <= 599)
      status = value;
  });
  return status;
}

/** Seconds the provider asked the client to wait, as a whole number. */
function retryAfterSecondsOf(error: unknown): number | undefined {
  let seconds: number | undefined;
  walkFailureNodes(error, (node) => {
    if (seconds !== undefined) return;
    const headers = readProperty(node, "responseHeaders");
    if (headers == null || typeof headers !== "object") return;
    const raw = (headers as Record<string, unknown>).get
      ? (readProperty(headers, "get") as (name: string) => unknown)("retry-after")
      : readProperty(headers, "retry-after");
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0)
      seconds = Math.min(Math.round(parsed), 3_600);
  });
  return seconds;
}

/**
 * Whether the message on this error can have come off the wire. `APICallError` (ai 4.3.17)
 * carries `requestBodyValues` — the whole prompt — plus `url`, `responseHeaders` and a stack
 * whose arguments can hold the credential, so copying text out of such an object is a leak
 * waiting to happen. Selecting a sentence by shape cannot leak, because nothing that came off
 * the wire is ever read.
 */
function isWireShapedError(error: unknown): boolean {
  let shaped = false;
  walkFailureNodes(error, (node) => {
    if (shaped) return;
    if (readProperty(node, "name") === "APICallError") shaped = true;
    for (const field of [
      "statusCode",
      "status",
      "responseBody",
      "responseHeaders",
      "requestBodyValues",
      "requestBody",
    ])
      if (readProperty(node, field) != null) {
        shaped = true;
        return;
      }
  });
  return shaped;
}

interface RunErrorSentence {
  readonly title?: string;
  readonly detail: string;
}

/**
 * The sentence for a failure the backend sent no curated text for. Every branch below either
 * picks from the table above or adds one of the three bounded facts; the last branch reads
 * `error.message`, and only when the error provably did not come off the wire.
 */
function runErrorSentenceOf(
  error: unknown,
  errorKind: string | undefined,
  curatedDetail: string | undefined,
): RunErrorSentence {
  if (errorKind === USER_CANCELLED_ERROR_KIND)
    return { title: TURN_CANCELLED_ERROR_TITLE, detail: TURN_CANCELLED_ERROR_DETAIL };
  if (errorKind === PROVIDER_OVERLOADED_ERROR_KIND)
    return {
      title: PROVIDER_OVERLOAD_ERROR_TITLE,
      detail: PROVIDER_OVERLOAD_ERROR_DETAIL,
    };
  if (curatedDetail !== undefined) return { detail: curatedDetail };

  const status = httpStatusOfFailure(error);
  if (status === 401)
    return {
      detail:
        "The model provider refused the API key (HTTP 401). Fix it in Settings → Router and send the message again. The key itself is not shown here.",
    };
  if (status === 403)
    return {
      detail:
        "The configured key is not allowed to use this model (HTTP 403). Change the key or the model in Settings → Router.",
    };
  if (status === 404)
    return {
      detail:
        "The model provider has no such model or endpoint (HTTP 404). The base URL or the model id in Settings → Router does not exist on this provider.",
    };
  if (status === 429) {
    const waitSeconds = retryAfterSecondsOf(error);
    return {
      detail:
        waitSeconds === undefined
          ? "The model provider is rate limiting this key (HTTP 429). Sending the message again after a short wait usually works."
          : `The model provider is rate limiting this key (HTTP 429) and asked to wait about ${waitSeconds}s. Sending the message again after that usually works.`,
    };
  }
  if (status === 400 || status === 422)
    return {
      detail: `The model provider refused the request (HTTP ${status}). A shorter conversation or a different model usually helps.`,
    };
  if (status !== undefined && status >= 500)
    return {
      detail: `The model provider failed with a server error (HTTP ${status}). The fault is on the provider side; sending the message again usually works.`,
    };
  if (safeIs(isFirstTokenStallError, error))
    return {
      detail:
        "The model provider stopped responding. No answer arrived within the time limit; sending the message again usually works.",
    };
  if (safeIs(isContextOverflowDeadEnd, error))
    return {
      detail:
        "This conversation no longer fits the model's context window. Start a new chat, or ask the agent to summarise the earlier turns before continuing.",
    };
  if (safeIs(isConversationTooLargeRefusal, error))
    return {
      detail:
        "This conversation is too large for the provider to accept. Start a new chat to continue; this one has passed the size the agent is allowed to send.",
    };
  if (safeIs(isTransientStreamError, error))
    return {
      detail:
        "The connection to the model provider broke before the answer finished. Nothing usable arrived; sending the message again usually works.",
    };
  // Our own sentences, from `new Error(...)` in this codebase, and bare strings. Trusted
  // precisely because the error carries nothing that came off the wire.
  if (!isWireShapedError(error)) {
    const message = safeBackendText(
      error != null && typeof error === "object"
        ? readProperty(error, "message")
        : stringOfUnknown(error),
    );
    if (message !== undefined) return { detail: message };
  }
  return { detail: UNCLASSIFIED_RUN_ERROR_DETAIL };
}

/** A predicate from another module, applied to an object that is allowed to throw. */
function safeIs(predicate: (error: unknown) => boolean, error: unknown): boolean {
  try {
    return predicate(error);
  } catch {
    return false;
  }
}

/**
 * The one description every tray is built from. It never raises: a classifier that raises
 * replaces the failure being classified, and the user gets nothing at all.
 *
 * `errorKind` is the machine half and `detail` is the sentence a human reads; `rawDetail` is
 * the backend's own sentence when it sent one, kept apart so a caller can tell "the backend
 * explained this" from "this build guessed". All three come from the closed table or from a
 * bounded fact — see the note above the credential refusal test.
 */
export function describeAgentRunError(error: unknown): Record<string, unknown> {
  const connectError = findBackendConnectError(error, false),
    detail =
      connectError == null ? undefined : readBackendDetails(connectError)[0];
  const backendTitle = safeBackendText(readProperty(detail, "title")),
    curatedDetail = safeBackendText(readProperty(detail, "detail")),
    actions = mapErrorDetailButtons(
      readProperty(detail, "buttons") as readonly ErrorButton[] | undefined,
    ),
    errorKind = classifyAgentRunErrorKind(error);
  const sentence = runErrorSentenceOf(error, errorKind, curatedDetail);
  // A curated backend title loses to the closed sentence, because the two kinds above are
  // precisely the cases where this build knows better than the backend's generic wording.
  const title = sentence.title ?? backendTitle;
  const additionalInfo = readProperty(detail, "additionalInfo");
  const nextResetAt = readProperty(additionalInfo, "nextResetAt");
  let shown = sentence.detail;
  if (
    readProperty(additionalInfo, "rateLimitReason") === SAND_INCLUDED_LIMIT_REASON &&
    typeof nextResetAt === "string"
  )
    shown = withRelativeSandIncludedLimitReset(shown, nextResetAt);
  return {
    ...(title === undefined ? {} : { title }),
    detail: shown,
    ...(errorKind === undefined ? {} : { errorKind }),
    ...(curatedDetail === undefined ? {} : { rawDetail: curatedDetail }),
    ...(actions.length === 0 ? {} : { actions }),
  };
}