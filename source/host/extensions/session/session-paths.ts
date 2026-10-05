import { readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getSandRootDir } from "../../host-paths.js";
import { assertValidSandAgentId, getSandAgentsRootDir } from "../../storage/agent-paths.js";
import { reportSessionDiagnostic } from "./session-diagnostics.js";

export const STORE_FILENAME = "store.db";
export const CONVERSATION_BLOBS_FILENAME = "conversation-blobs.db";
export const SAND_CONVERSATION_ROOT_SLOT_ID = new TextEncoder().encode("sand-live-conversation-root-v1__");
export const STALE_ROOT_CLEANUP_VERSION = 1;
export const ACTIVE_AGENT_FILENAME = "active-agent.json";
export const HIDDEN_ENTRY_REPAIR_VERSION = 1;
export const LEGACY_GROUP_MEMBERS_DIRNAME = "members";
export const CONNECTOR_SECRETS_DIRNAME = "connector-secrets";

let pinnedStaleRootGcEnabled = false;

export function pinStaleRootGc(enabled: boolean): void { pinnedStaleRootGcEnabled = enabled; }
export function isStaleRootGcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SAND_STALE_ROOT_GC?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return pinnedStaleRootGcEnabled;
}
export function getSandTranscriptsDir(homeDir = homedir()): string { return join(getSandRootDir(homeDir), "agent-transcripts"); }
/**
 * The one definition of "which agents exist on this host".
 *
 * A directory under `agents/` IS an agent. It may be blank, it may be one whose
 * delete is in flight, it may be a placeholder no roster shows — it still
 * occupies one of the fifty slots `isAgentCapReached` computes from, and a count
 * that disagreed with this one made `countAgents` answer 49 while 50 directories
 * sat on disk.
 *
 * It used to be written out twice, in `SandAgentSessionStore.listAgentIds` and
 * in `SandSessionMaterialization.listAgentRecordIds`. Two copies of one rule is
 * two chances for the cap and the counter to drift apart.
 */
export async function listAgentDirectoryIds(agentsRootDir: string): Promise<string[]> {
  try { return (await readdir(agentsRootDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export function getAgentDbPath(rootDir: string, agentId: string): string { assertValidSandAgentId(agentId); return join(rootDir, agentId, STORE_FILENAME); }
export function getConnectorSecretsRoot(agentsRootDir = getSandAgentsRootDir()): string { return join(dirname(agentsRootDir), CONNECTOR_SECRETS_DIRNAME); }

function errorClass(error: unknown): string { return error instanceof Error ? error.name : typeof error; }
export async function statIfExists(path: string): Promise<Stats | undefined> {
  try { return await stat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") reportSessionDiagnostic({ family: "store_db", kind: "path_stat_failed", agentId: basename(dirname(path)), errorClass: errorClass(error) });
    return undefined;
  }
}
