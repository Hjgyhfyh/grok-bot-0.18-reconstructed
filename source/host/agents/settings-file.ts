import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SAND_SETTINGS_FILENAME = "settings.json";
export const DEFAULT_NOTIFY_ON_AGENT_UPDATES = true;
export const DEFAULT_HIDDEN_FROM_SIDEBAR = false;

export interface SandAgentSettings { notifyOnAgentUpdates: boolean; hiddenFromSidebar: boolean }

export function getSandSettingsPath(agentDir: string): string { return join(agentDir, SAND_SETTINGS_FILENAME); }

function readRawSettings(path: string): Record<string, unknown> {
  try {
    // A UTF-8 BOM makes `JSON.parse` throw, and a throw here answered `{}` — so an agent whose
    // file carries one read as `notifyOnAgentUpdates: true, hiddenFromSidebar: false` no matter
    // what the file said, on every read, for good. The global store has stripped the BOM on read
    // since the beginning; this reader did not. It is stripped on write too, so the file heals
    // the first time anything changes a setting.
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/** True when the file exists but does not hold the object this store can rewrite from its own contents. */
function storedFileIsForeign(path: string): boolean {
  if (!existsSync(path)) return false;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return false; }
  try { const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, "")); return typeof parsed !== "object" || parsed === null || Array.isArray(parsed); }
  catch { return true; }
}

export function readSandSettingsFile(path: string): SandAgentSettings {
  const raw = readRawSettings(path);
  return {
    notifyOnAgentUpdates: typeof raw.notifyOnAgentUpdates === "boolean" ? raw.notifyOnAgentUpdates : DEFAULT_NOTIFY_ON_AGENT_UPDATES,
    hiddenFromSidebar: typeof raw.hiddenFromSidebar === "boolean" ? raw.hiddenFromSidebar : DEFAULT_HIDDEN_FROM_SIDEBAR
  };
}

export function writeSandSettingsFile(path: string, update: Partial<SandAgentSettings>): void {
  // A file this store cannot parse was overwritten in place, with no copy, by the first ordinary
  // toggle. The bytes are taken first and that one write waits, so a later write finds the copy
  // and proceeds: a damaged file must not freeze an agent's settings for good.
  if (storedFileIsForeign(path)) {
    const kept = `${path}.unreadable`;
    if (!existsSync(kept)) {
      let copied = false;
      try { writeFileSync(kept, readFileSync(path)); copied = true; } catch {}
      if (copied) return;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...readRawSettings(path), ...update }, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
