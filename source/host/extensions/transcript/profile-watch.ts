import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import type { EventEmitter } from "node:events";

import { SAND_DEFAULT_AGENT_NAME } from "../../../shared/agents/agents.js";
import {
  invalidateAvatarDataUrlCache,
  isConventionalAvatarFilename,
} from "../../agents/agent-avatar.js";
import {
  getSandProfilePath,
  readSandProfileFile,
  SAND_PROFILE_FILENAME,
} from "../../agents/agent-profile.js";
import {
  getSandSettingsPath,
  SAND_SETTINGS_FILENAME,
} from "../../agents/settings-file.js";
import {
  AGENT_INSTRUCTIONS_FILENAME,
  readAgentInstructions,
} from "../../runner/system-prompt-assembly.js";
import type { RosterEmit } from "./roster-emit.js";
import type { Disposable, TranscriptManagerLike } from "./transcript-hub.js";

export const PROFILE_WATCH_DEBOUNCE_MS = 50;

export class ProfileWatch {
  readonly lastKnownAgentNames = new Map<string, string>();
  private profileWatcher: FSWatcher | undefined;
  private profileWatchTimer: Disposable | undefined;
  private watchedProfileAgentId: string | undefined;

  constructor(
    readonly tm: TranscriptManagerLike,
    readonly emitter: EventEmitter,
    readonly rosterEmit: RosterEmit,
  ) {}

  emitProfileChanged(agentId: string): void {
    this.recordNameChangeEvent(agentId);
    this.emitter.emit("profile-changed", { agentId });
  }

  recordNameChangeEvent(agentId: string): void {
    const currentName =
      this.tm.sessionStore.getAgentProfileText(agentId)?.name.trim() ?? "";
    if (currentName.length === 0) return;
    const previousName = this.lastKnownAgentNames.get(agentId);
    this.lastKnownAgentNames.set(agentId, currentName);
    if (previousName == null || previousName === currentName) return;
    this.tm.emitTimelineEvent(agentId, {
      type: "name-changed",
      from: previousName,
      to: currentName,
    });
  }

  seedKnownAgentName(agentId: string): void {
    if (this.lastKnownAgentNames.has(agentId)) return;
    const name =
      this.tm.sessionStore.getAgentProfileText(agentId)?.name.trim() ?? "";
    if (name.length > 0) this.lastKnownAgentNames.set(agentId, name);
  }

  subscribeProfileChanged(
    listener: (event: { agentId: string }) => void,
  ): () => void {
    this.emitter.on("profile-changed", listener);
    return () => this.emitter.off("profile-changed", listener);
  }

  watchSessionProfile(session: { id: string; dbPath: string }): void {
    if (this.watchedProfileAgentId === session.id) return;
    this.stopWatchingProfile();
    this.watchedProfileAgentId = session.id;
    this.seedKnownAgentName(session.id);
    try {
      this.profileWatcher = watch(
        dirname(session.dbPath),
        (_event, filename) => {
          if (
            filename !== SAND_PROFILE_FILENAME &&
            filename !== SAND_SETTINGS_FILENAME &&
            filename !== AGENT_INSTRUCTIONS_FILENAME &&
            (filename == null || !isConventionalAvatarFilename(filename))
          )
            return;
          this.scheduleProfileEmit();
        },
      );
    } catch {
      // A missing/unwatchable directory is refreshed by normal roster emits.
    }
  }

  scheduleProfileEmit(): void {
    if (this.profileWatchTimer != null) return;
    this.profileWatchTimer = this.tm.clock.schedule(
      PROFILE_WATCH_DEBOUNCE_MS,
      () => {
        this.profileWatchTimer = undefined;
        const agentId = this.watchedProfileAgentId;
        if (agentId == null) {
          void this.rosterEmit.emitAgents();
          return;
        }
        const active = this.tm.sessions.activeSession;
        if (active?.id === agentId)
          invalidateAvatarDataUrlCache(dirname(active.dbPath));
        void this.rosterEmit.emitAgentUpdate(agentId);
        this.emitProfileChanged(agentId);
      },
    );
  }

  stopWatchingProfile(): void {
    this.profileWatcher?.close();
    this.profileWatcher = undefined;
    this.profileWatchTimer?.dispose();
    this.profileWatchTimer = undefined;
    this.watchedProfileAgentId = undefined;
  }

  async getAgentDisplayProfile(agentId: string): Promise<{
    name: string;
    description: string;
  } | null> {
    const dir = this.tm.sessionStore.getAgentDir(agentId);
    if (!existsSync(dir)) return null;
    const profile = readSandProfileFile(getSandProfilePath(dir));
    return {
      name: profile?.name.trim() || SAND_DEFAULT_AGENT_NAME,
      description: profile?.description ?? "",
    };
  }

  /**
   * Everything about one agent that the host resolves from its folder.
   *
   * `instructions` is here for the same reason `filePath` and `settingsFilePath`
   * are: it is a thing this agent has, it lives in a file, and the file is named
   * so that a caller can show it to the user. The resolved profile used to answer
   * a name and a description only, which is exactly the pair an agent card renders —
   * so the one field that decides what the agent IS was reachable by the turn
   * (`agentInstructionProvider` reads the same file on every prompt build) and by
   * nobody who could show it. An instruction the user wrote could not be read back
   * anywhere in the product.
   *
   * `undefined` on `profile` means `profile.json` is gone or unreadable, which says
   * nothing about `instructions.md`: that file is written once and rewritten only
   * by an instruction edit, so a lost profile cannot take the brief with it and the
   * two are reported independently.
   */
  resolveAgentProfile(session: { dbPath: string }): {
    name: string;
    description: string;
    instructions: string;
    filePath: string;
    settingsFilePath: string;
    instructionsFilePath: string;
  } {
    const dir = dirname(session.dbPath);
    const filePath = getSandProfilePath(dir);
    const profile = readSandProfileFile(filePath);
    return {
      name: profile?.name.trim() || SAND_DEFAULT_AGENT_NAME,
      description: profile?.description ?? "",
      instructions: readAgentInstructions(dir),
      filePath,
      settingsFilePath: getSandSettingsPath(dir),
      instructionsFilePath: join(dir, AGENT_INSTRUCTIONS_FILENAME),
    };
  }
}
