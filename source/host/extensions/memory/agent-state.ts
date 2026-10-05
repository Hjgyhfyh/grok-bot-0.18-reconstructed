import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isSafeFolderId } from "../../storage/folder-id.js";
import { normalizeMemoryContent } from "../../runner/sand-memory.js";
import { serializeWorkflowFile } from "../../../shared/workflow-model.js";
import { describeTrigger } from "../../../shared/automation-schedule.js";
import type { AutomationTrigger } from "../../../shared/automations.js";
import { CANONICAL_AVATAR_FILENAME, invalidateAvatarDataUrlCache, listConventionalAvatarFilenames, sniffAvatarMimeType } from "../../agents/agent-avatar.js";
import { isBoxRootPath } from "../../box/box-transfer.js";
import { FileMemoryStore, getProjectDir, getProjectMemoryShardDir, getUserMemoryShardDir, projectDirExists, type MemoryKind } from "./memory-service.js";

/**
 * The union `SandStateWriter` declares in `runner/tools/sand-state-tool.ts` and
 * the tool reads: `createSandStateTool` returns `outcome.detail` on success and
 * `Not saved — ${outcome.reason}` on a refusal. This file used to spell the same
 * union as `{ ok, message }`, so every successful `update_state` handed the
 * model `undefined` and every refusal read "Not saved — undefined" — including
 * the profile write below, which therefore renamed the agent in silence.
 * Nothing in the repository reads `.message` off this result.
 */
export type StateWriteResult = { ok: true; detail: string } | { ok: false; reason: string };
const ok = (detail: string): StateWriteResult => ({ ok: true, detail }), fail = (reason: string): StateWriteResult => ({ ok: false, reason });
const blank = (value?: string | null): boolean => value == null || value.trim().length === 0;
export const MEMORY_NOTE_PREFIX = "Note: ";
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const immediateDebounce = { name: "sand-agent-state-memory-shard", wrap: <T extends (...args: never[]) => unknown>(fn: T) => Object.assign(fn, { dispose() {} }) };

interface MemoryPort { addMemory(content: string, at: number, kind: MemoryKind): { content: string } | null; removeMemoryByContent(content: string): boolean }
interface AutomationPort { upsert(spec: unknown, now?: number): { id: string; name: string; isEnabled?: boolean; trigger: AutomationTrigger } | null; update(id: string, spec: unknown): { id: string; name: string; isEnabled?: boolean; trigger: AutomationTrigger } | null; setEnabled(id: string, enabled: boolean): { id: string; name: string } | null; get(id: string): { name: string } | null; remove(id: string): boolean }
interface WorkflowPort { create(spec: unknown): { id: string; name: string } | null; update(id: string, spec: unknown): { id: string; name: string } | null; remove(id: string): boolean }
interface MembershipPort { read(): ReadonlySet<string>; join(slug: string): boolean; leave(slug: string): boolean }
export interface AgentStateDeps {
  agentId: string; agentDir: string; sandRoot: string; memory: MemoryPort; membership: MembershipPort; channels: { remove(platform: string): boolean };
  automations: AutomationPort; workflows: WorkflowPort; now?: () => number;
  /**
   * Writes this agent's own profile through the host, the same `updateAgent`
   * the profile edit screen calls. It is a function and not a pair of file
   * primitives because the host is what merges: it fills every field the
   * caller left out from what is already stored, validates the instruction
   * ceiling before anything is written, and re-emits the roster event the UI
   * repaints on. A writer here would have to re-implement all three and would
   * drift the moment the host grew a rule.
   */
  updateOwnProfile(patch: { name?: string; description?: string; title?: string }): Promise<unknown>;
  writeSettings(settings: Record<string, boolean>): void;
  readBoxFile?(path: string): Promise<Uint8Array>; onAvatarChanged?(): void;
}
function shardFor(deps: AgentStateDeps, scope: "agent" | "user" | "project", project?: string): { store: MemoryPort; label: string } | StateWriteResult {
  if (scope === "agent") return { store: deps.memory, label: "your memory" };
  if (scope === "user") return { store: new FileMemoryStore(getUserMemoryShardDir(deps.sandRoot, deps.agentId), immediateDebounce), label: "shared user memory" };
  if (blank(project)) return fail("'project' (the slug) is required when scope is project.");
  const slug = project?.trim() ?? "";
  if (!isSafeFolderId(slug)) return fail(`"${slug}" is not a valid project slug — use a short kebab-case id.`);
  if (!projectDirExists(deps.sandRoot, slug)) return fail(`no project "${slug}" exists yet. Create or join it first (target "project").`);
  if (!deps.membership.read().has(slug)) return fail(`you haven't joined project "${slug}" yet. Join it first (target "project", action "join").`);
  return { store: new FileMemoryStore(getProjectMemoryShardDir(deps.sandRoot, slug, deps.agentId), immediateDebounce), label: `project "${slug}" memory` };
}
function remember(store: MemoryPort, content: string, tier: "profile" | "note" | "log", at: number, label: string): StateWriteResult { const record = store.addMemory(tier === "note" ? `${MEMORY_NOTE_PREFIX}${content.trim()}` : content, at, tier === "profile" ? "profile" : "log"); return record == null ? fail(`nothing was saved to ${label} — the fact was empty or already recorded. Grep the memory folder to see what is already there.`) : ok(`Remembered in ${label} (${tier}): ${record.content}`); }
function describeAutomation(value: ReturnType<AutomationPort["upsert"]>, verb: string): StateWriteResult { return value == null ? fail("the routine could not be saved — check that the name and instruction are non-empty and the trigger is valid.") : ok(`${verb} routine "${value.name}" (folder ${value.id}) — ${describeTrigger(value.trigger)}${value.isEnabled ? "" : ", paused"}.`); }
const avatarExtension = (mime: string): string | null => ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" })[mime] ?? null;

export function createSandAgentState(deps: AgentStateDeps) {
  const now = deps.now ?? Date.now;
  return {
    async writeMemory({ content, tier, scope = "agent", project }: { content: string; tier: "profile" | "note" | "log"; scope?: "agent" | "user" | "project"; project?: string }) { const shard = shardFor(deps, scope, project); return "ok" in shard ? shard : remember(shard.store, content, tier, now(), shard.label); },
    async removeMemory({ content, scope = "agent", project }: { content: string; scope?: "agent" | "user" | "project"; project?: string }) { const shard = shardFor(deps, scope, project); if ("ok" in shard) return shard; return shard.store.removeMemoryByContent(content) ? ok(`Forgot from ${shard.label}: ${normalizeMemoryContent(content)}`) : fail(`no fact with exactly that text is recorded in ${shard.label}. Read or grep the folder for the exact wording first.`); },
    async createAutomation({ spec }: { spec: unknown }) { return describeAutomation(deps.automations.upsert(spec, now()), "Saved"); },
    async updateAutomation({ id, spec }: { id: string; spec: unknown }) { const updated = deps.automations.update(id, spec); return updated == null ? fail(`no routine with folder "${id}" exists, or the new fields were invalid.`) : describeAutomation(updated, "Updated"); },
    async setAutomationEnabled({ id, isEnabled }: { id: string; isEnabled: boolean }) { const value = deps.automations.setEnabled(id, isEnabled); return value == null ? fail(`no routine with folder "${id}" exists.`) : ok(`${isEnabled ? "Resumed" : "Paused"} routine "${value.name}" (folder ${value.id}).`); },
    async deleteAutomation({ id }: { id: string }) { const name = deps.automations.get(id)?.name ?? id; return deps.automations.remove(id) ? ok(`Deleted routine "${name}" (folder ${id}).`) : fail(`no routine with folder "${id}" exists.`); },
    async writeWorkflow(args: { id?: string; name: string; description?: string; body: string }) { const spec = { name: args.name, description: args.description ?? "", body: args.body, trigger: null }, value = args.id == null ? deps.workflows.create(spec) : deps.workflows.update(args.id, spec); return value == null ? fail(args.id == null ? "the workflow could not be saved — a name and a non-empty body are both required." : `no workflow with id "${args.id}" exists, or the new fields were invalid. Cursor-managed skills cannot be edited.`) : ok(`${args.id == null ? "Saved" : "Updated"} workflow "${value.name}" (id ${value.id}).`); },
    async deleteWorkflow({ id }: { id: string }) { return deps.workflows.remove(id) ? ok(`Deleted workflow ${id}.`) : fail(`no workflow with id "${id}" exists, or it is a Cursor-managed skill, which cannot be deleted.`); },
    async updateProfile(args: { name?: string; description?: string; title?: string }) {
      const fields = ["name", "description", "title"] as const;
      const changed = fields.filter((field) => args[field] !== undefined);
      if (changed.length === 0) return fail("nothing to change — pass at least one of name, title or description.");
      if (args.name !== undefined && blank(args.name)) return fail("a blank name is not allowed.");
      // The one production caller reaches this owner through `method()`, typed
      // `(...args: any[]) => any`, so the compiler cannot enforce the binding the
      // signature above states. The guard is what turns a missing writer into a
      // sentence the model can act on: the previous version called
      // `deps.readProfile`, which no caller ever supplied, and every profile
      // write ended on `TypeError: deps.readProfile is not a function`.
      if (typeof deps.updateOwnProfile !== "function") return fail("this session cannot write its own profile — no profile writer is bound to it.");
      const patch: { name?: string; description?: string; title?: string } = {};
      for (const field of changed) patch[field] = args[field]!.trim();
      try {
        const summary = await deps.updateOwnProfile(patch);
        if (summary == null) return fail("your profile was not changed — the host answered with nothing. Say so rather than telling the user it worked.");
        return ok(`Updated your ${changed.join(", ")}.`);
      } catch (error) {
        return fail(`your profile was not changed — ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async updateSettings(args: { hiddenFromSidebar?: boolean; notifyOnAgentUpdates?: boolean }) { const update = { ...(args.hiddenFromSidebar === undefined ? {} : { hiddenFromSidebar: args.hiddenFromSidebar }), ...(args.notifyOnAgentUpdates === undefined ? {} : { notifyOnAgentUpdates: args.notifyOnAgentUpdates }) }; if (Object.keys(update).length === 0) return fail("nothing to change — pass at least one setting field."); deps.writeSettings(update); return ok(`Updated your settings: ${Object.keys(update).join(", ")}.`); },
    async disconnectChannel({ platform }: { platform: string }) { return deps.channels.remove(platform) ? ok(`Disconnected ${platform}. The connector closes the live connection within a few seconds.`) : fail(`${platform} is not connected.`); },
    async createProject({ slug, name, description }: { slug: string; name: string; description?: string }) { const id = slug.trim(); if (!isSafeFolderId(id)) return fail(`"${id}" is not a valid project slug — use a short kebab-case id.`); if (blank(name)) return fail("a project needs a non-empty name."); const path = getProjectDir(deps.sandRoot, id), existed = projectDirExists(deps.sandRoot, id); if (!existed) { await mkdir(path, { recursive: true }); await writeFile(join(path, "project.md"), serializeWorkflowFile({name:name.trim(),description:description?.trim()??"",body:"",trigger:null}), "utf8"); } return deps.membership.join(id) ? ok(existed ? `Joined existing project "${id}" (create-is-join; project.md left as-is).` : `Created and joined project "${name.trim()}" (folder ${id}).`) : fail(`could not join project "${id}" — the slug is not path-safe.`); },
    async joinProject({ slug }: { slug: string }) { const id = slug.trim(); if (!isSafeFolderId(id)) return fail(`"${id}" is not a valid project slug — use a short kebab-case id.`); if (!projectDirExists(deps.sandRoot, id)) return fail(`no project "${id}" exists. Create it first (action "create").`); return deps.membership.join(id) ? ok(`Joined project "${id}".`) : fail(`could not join project "${id}".`); },
    async leaveProject({ slug }: { slug: string }) { const id = slug.trim(); if (!isSafeFolderId(id)) return fail(`"${id}" is not a valid project slug — use a short kebab-case id.`); return deps.membership.leave(id) ? ok(`Left project "${id}".`) : fail(`could not leave project "${id}".`); },
    async setAvatar({ path }: { path: string }) { if (blank(path)) return fail("pass the path of an image file to install."); const absolute = isAbsolute(path.trim()) ? path.trim() : resolve(path.trim()); let bytes: Uint8Array | null = null; try { bytes = await readFile(absolute); } catch { if (deps.readBoxFile != null && isBoxRootPath(absolute)) try { bytes = await deps.readBoxFile(absolute); } catch {} } if (bytes == null) return fail(isBoxRootPath(absolute) ? `could not read "${basename(absolute)}" from your box — write the image with Shell (or CopyFromBox onto a host path) first, then pass that path.` : `could not read "${basename(absolute)}" — download or write the image somewhere first, then pass that path.`); if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) return fail(`the image must be under ${AVATAR_MAX_BYTES / (1024 * 1024)} MB and non-empty.`); const mime = sniffAvatarMimeType(bytes), ext = mime == null ? null : avatarExtension(mime); if (ext == null) return fail("that file is not a recognized image (png, jpg, webp, gif, or svg)."); await mkdir(deps.agentDir, { recursive: true }); for (const name of listConventionalAvatarFilenames(deps.agentDir)) await rm(join(deps.agentDir, name), { force: true }); const filename = ext === "png" ? CANONICAL_AVATAR_FILENAME : `avatar.${ext}`; await writeFile(join(deps.agentDir, filename), bytes); invalidateAvatarDataUrlCache(deps.agentDir); deps.onAvatarChanged?.(); return ok(`Updated your picture (${filename}). Source ${basename(absolute)} can be deleted if you no longer need it.`); },
    async clearAvatar() { const files = listConventionalAvatarFilenames(deps.agentDir); if (files.length === 0) return fail("you already have the default picture."); for (const name of files) await rm(join(deps.agentDir, name), { force: true }); invalidateAvatarDataUrlCache(deps.agentDir); deps.onAvatarChanged?.(); return ok("Cleared your picture — back to the default."); }
  };
}
