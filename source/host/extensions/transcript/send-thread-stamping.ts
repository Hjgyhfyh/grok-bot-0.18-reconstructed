import {
  stripReplyTo,
  withReplyTo,
  type SendMessage,
} from "./send-message-shaping.js";
import type { TranscriptEntry } from "./transcript-hub.js";
export function resolveSendReplyThreading(
  tm: {
    turnRuntime: {
      resolveReplyTarget(
        entries: readonly TranscriptEntry[],
        id: string,
      ): string | undefined;
      buildReplyContext(
        entries: readonly TranscriptEntry[],
        id?: string,
      ): unknown;
    };
  },
  replyToIdOption: string | undefined,
  isForkOption: boolean,
  readAddressedTranscript: () => readonly TranscriptEntry[],
  readDurableEntry?: (id: string) => TranscriptEntry | null,
): { replyToId?: string; replyContext: unknown; isFork: boolean } {
  const entries = replyToIdOption ? readAddressedTranscript() : [];
  // A thread is a `replyTo` chain, not a separate id: the renderer sends `replyToId`
  // plus `isFork` and the host stamps `replyTo` + `branched` from them. The candidate
  // was checked only against the in-memory transcript, which is a cache rather than the
  // record — `clearActiveTranscript` even resets it to an empty list while still
  // claiming to belong to the active agent. On that miss the reply target was silently
  // dropped, `branched` was never stamped, and the user's message left the open thread
  // for the main feed: invisible from where they were looking, with the agent's answer
  // following it out. The durable store already holds the entry, so it decides.
  let replyEntries = entries;
  let replyToId = replyToIdOption
    ? tm.turnRuntime.resolveReplyTarget(entries, replyToIdOption)
    : undefined;
  if (replyToId == null && replyToIdOption != null && readDurableEntry != null) {
    const durable = readDurableEntry(replyToIdOption);
    if (durable != null) {
      replyToId = replyToIdOption;
      replyEntries = [...entries, durable];
    }
  }
  const replyContext = tm.turnRuntime.buildReplyContext(replyEntries, replyToId);
  return {
    ...(replyToId == null ? {} : { replyToId }),
    replyContext,
    isFork: isForkOption && replyToId != null,
  };
}
export function validateAiReplyTarget<T extends SendMessage>(
  message: T,
  inFlightId: string | undefined,
  entries: readonly TranscriptEntry[],
): T {
  const target = message.reply_to;
  return target == null || target.length === 0
    ? message
    : target === inFlightId || !entries.some((entry) => entry.id === target)
      ? stripReplyTo(message)
      : message;
}
export function applyAutoReplyThread<T extends SendMessage>(
  tm: { turnRuntime: { replyThreadTargets: ReadonlyMap<object, string> } },
  message: T,
  session: object | null,
  entries: readonly TranscriptEntry[],
): T {
  if (message.reply_to || session == null) return message;
  const target = tm.turnRuntime.replyThreadTargets.get(session);
  return target != null && entries.some((entry) => entry.id === target)
    ? withReplyTo(message, target)
    : message;
}
