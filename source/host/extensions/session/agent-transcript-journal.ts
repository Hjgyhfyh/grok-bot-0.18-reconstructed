import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * One place that knows where a conversation's transcript journal lives.
 *
 * The writer is `FileTranscriptMirror`
 * (`source/host/transcript-mirror/transcript-mirror.ts`), which builds
 * `<transcriptsDir>/<conversationId>/<conversationId>.jsonl` plus the
 * `.journal-mode`, `.journal-pending.json` and `.journal-cursor.json` siblings
 * from `getSandTranscriptsDir()`. The delete used to rebuild that same path by
 * hand inside `SandAgentSessionStore`, from `dirname(rootDir)`. Two derivations
 * of one path in two files is two chances to point at different places, and the
 * failure is invisible: the delete answers `200`, the agent is gone, and the
 * directory that was supposed to go with it is still there.
 *
 * `dirname(getSandAgentsRootDir())` is `getSandRootDir()`, which is what
 * `getSandTranscriptsDir()` starts from, so one derivation from the store root
 * reaches the same place the writer reaches. The equivalence is asserted in
 * `tests/agent-transcript-journal.test.mjs` rather than assumed here.
 */
export const TRANSCRIPT_JOURNAL_DIRNAME = "agent-transcripts";

/**
 * The writer accepts a conversation id matching this pattern and refuses `.`
 * and `..` outright (`safeId` in the mirror). The delete has to refuse exactly
 * the same ids: a looser rule turns a delete into a recursive unlink of
 * whatever `..` resolves to, and a stricter one leaves a journal nobody can
 * remove.
 */
export function isSafeTranscriptJournalId(conversationId: string): boolean {
  return (
    typeof conversationId === "string" &&
    /^[A-Za-z0-9._-]+$/.test(conversationId) &&
    conversationId !== "." &&
    conversationId !== ".."
  );
}

/** The directory one conversation's journal occupies, derived from the agents root. */
export function transcriptJournalDirFor(
  agentsRootDir: string,
  conversationId: string,
): string {
  return join(
    dirname(agentsRootDir),
    TRANSCRIPT_JOURNAL_DIRNAME,
    conversationId,
  );
}

export interface TranscriptJournalRemoval {
  /** Conversation ids whose journal directory is gone. */
  readonly removed: string[];
  /** Conversation ids whose journal directory is still on disk. */
  readonly leftovers: string[];
  /** One line per conversation the delete refused to touch, with the reason. */
  readonly refused: { conversationId: string; reason: string }[];
}

/**
 * Removes the journal directory of every conversation id in `conversationIds`,
 * and reports which ones are still there.
 *
 * Two properties this function is built around:
 *
 *  - **It removes exactly the ids it is given.** A sweep over
 *    `agent-transcripts/*` that keeps every directory without a matching agent
 *    directory is the obvious cheap fix for the orphan count, and it is wrong:
 *    a subagent conversation has no agent directory of its own, so the sweep
 *    eats the journals of agents that are alive, and an agent whose delete is
 *    in flight has its directory for a moment after the roster stopped showing
 *    it. Both look like garbage from here and are not.
 *  - **It does not swallow a failure.** The previous version reported a
 *    diagnostic and returned, so a journal that a live holder kept on disk was
 *    indistinguishable from one that was removed. The caller now gets the
 *    survivors and can say so.
 */
export async function removeTranscriptJournals(args: {
  agentsRootDir: string;
  conversationIds: readonly string[];
  maxRetries?: number;
  retryDelayMs?: number;
}): Promise<TranscriptJournalRemoval> {
  const removed: string[] = [];
  const leftovers: string[] = [];
  const refused: { conversationId: string; reason: string }[] = [];
  for (const conversationId of args.conversationIds) {
    if (!isSafeTranscriptJournalId(conversationId)) {
      refused.push({
        conversationId,
        reason: "not a conversation id the transcript writer would ever create",
      });
      continue;
    }
    const dir = transcriptJournalDirFor(args.agentsRootDir, conversationId);
    try {
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: args.maxRetries ?? 2,
        retryDelay: args.retryDelayMs ?? 25,
      });
    } catch {
      // Fall through to the check below: `rm` reports the last failure it saw
      // for one child, and a directory that is gone is a directory that is gone.
    }
    if (existsSync(dir)) leftovers.push(conversationId);
    else removed.push(conversationId);
  }
  return { removed, leftovers, refused };
}