import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runRoutedProviderText } from "../host/extensions/inference/provider-session.js";
import type { SandInferenceProvider } from "../shared/inference-router.js";
import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";

type StoredEntry = {
  readonly provider: Exclude<SandInferenceProvider, "cursor">;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly richText?: string;
  readonly id: string;
  readonly clientNonce?: string;
  readonly reactions?: readonly { readonly emoji: string; readonly by: string }[];
  readonly timestampMs: number;
};
type Store = { readonly schemaVersion: 2; readonly agents: Readonly<Record<string, readonly StoredEntry[]>> };

const EMPTY_STORE: Store = { schemaVersion: 2, agents: {} };

// A title the model authors arrives as a JSON object carrying UI control fields:
// `{"isNewTopic":true,"title":"..."}`. It is a protocol message addressed to the
// application, not something the user wrote or the user should read, so this route consumes
// it and applies it to the agent profile. The transcript renders every stored assistant
// string as a text bubble (see `projectInferenceRouterTranscriptEntry`), so a control payload
// treated as text is shown to the user as raw JSON.
//
// The envelope has to be strict. A reply that merely starts with `{` is ordinary assistant
// text and must never be treated as a control payload, so the recogniser accepts one only
// when the whole reply is one JSON object, every key is a known control key, and
// `isNewTopic` is a boolean.
const ROUTED_CONTROL_KEYS = new Set(["isNewTopic", "title"]);
const MAX_CONTROL_ENVELOPE_CHARS = 512;
const MAX_CONTROL_TITLE_CHARS = 80;

// The naming request is the one thing this route still asks a model for. It carries no tool
// list on purpose: naming a conversation needs no hands, and a tool the model could call
// here would be a tool call with no agent behind it. The instruction lives in the message
// rather than in `GROK_ROUTER_SYSTEM_PROMPT`, which this route does not own.
const ROUTED_TITLE_INSTRUCTION = [
  "Name this conversation for the user's chat list. Reply with one JSON object and nothing else.",
  '{"isNewTopic":true,"title":"..."}',
  "The title is at most five words, in the language the user wrote in, and it names the subject rather than restating the question.",
  "Do not answer the user, do not explain yourself, and do not use any tool.",
].join("\n");
// The first message is the only thing a title can honestly come from, and a pasted document
// is not a conversation. Bounding it keeps one enormous paste from becoming the whole prompt.
const ROUTED_TITLE_SOURCE_CHARS = 600;

export interface RoutedControlEnvelope {
  readonly isNewTopic: boolean;
  readonly title: string | null;
}

export function parseRoutedControlEnvelope(text: string): RoutedControlEnvelope | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CONTROL_ENVELOPE_CHARS) return null;
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  const record = asRecord(parsed);
  if (record == null) return null;
  const keys = Object.keys(record);
  if (keys.length === 0 || !keys.every(key => ROUTED_CONTROL_KEYS.has(key))) return null;
  if (typeof record.isNewTopic !== "boolean") return null;
  const rawTitle = typeof record.title === "string" ? record.title.trim() : "";
  return {
    isNewTopic: record.isNewTopic,
    title: rawTitle.length > 0 && rawTitle.length <= MAX_CONTROL_TITLE_CHARS ? rawTitle : null,
  };
}

// What a partially streamed reply is so far: still undecidable, ordinary assistant text, or a
// control payload. `pending` is bounded by `MAX_CONTROL_ENVELOPE_CHARS`, so a reply that opens
// with a brace can never be withheld indefinitely and the turn can never hang.
//
// Nothing streams a routed reply into the chat any more — no routed reply is ever shown to the
// user at all — but the rule stays exported because it is the incremental form of the contract
// `parseRoutedControlEnvelope` enforces on the finished reply.
export function classifyRoutedReply(accumulated: string): "pending" | "text" | "control" {
  const trimmed = accumulated.trim();
  if (trimmed.length === 0) return "pending";
  if (!trimmed.startsWith("{")) return "text";
  if (trimmed.length > MAX_CONTROL_ENVELOPE_CHARS) return "text";
  if (parseRoutedControlEnvelope(trimmed) != null) return "control";
  if (trimmed.endsWith("}")) {
    try { JSON.parse(trimmed); return "text"; } catch { return "pending"; }
  }
  return "pending";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseInferenceRouterTranscriptStore(value: unknown): Store {
  const root = asRecord(value);
  if (root?.schemaVersion !== 2 || asRecord(root.agents) == null) return EMPTY_STORE;
  const agents: Record<string, StoredEntry[]> = {};
  for (const [agentId, rawEntries] of Object.entries(root.agents as Record<string, unknown>)) {
    if (!Array.isArray(rawEntries)) continue;
    const entries: StoredEntry[] = [];
    for (const raw of rawEntries) {
      const row = asRecord(raw);
      if (row == null || !["codex", "claude-code", "openrouter", "custom"].includes(String(row.provider)) || !["user", "assistant"].includes(String(row.role)) || typeof row.content !== "string" || typeof row.id !== "string" || typeof row.timestampMs !== "number" || (row.clientNonce !== undefined && typeof row.clientNonce !== "string") || (row.richText !== undefined && typeof row.richText !== "string")) continue;
      if (row.reactions !== undefined && (!Array.isArray(row.reactions) || row.reactions.some(reaction => asRecord(reaction) == null || typeof asRecord(reaction)!.emoji !== "string" || typeof asRecord(reaction)!.by !== "string"))) continue;
      entries.push(row as unknown as StoredEntry);
    }
    agents[agentId] = entries.slice(-200);
  }
  return { schemaVersion: 2, agents };
}

export function projectInferenceRouterTranscriptEntry(entry: StoredEntry): Record<string, unknown> {
  return entry.role === "user"
    ? { kind: "message", id: entry.id, role: "user", content: entry.content, ...(entry.richText === undefined ? {} : { richText: entry.richText }), isStreaming: false, timestampMs: entry.timestampMs, ...(entry.clientNonce === undefined ? {} : { clientNonce: entry.clientNonce }), ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }) }
    : { kind: "send-message", id: entry.id, message: { type: "text", content: entry.content }, timestampMs: entry.timestampMs, ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }) };
}

export function createCoordinatorInferenceRouter(options: {
  readonly dataDir: string;
  readonly postEvent: (family: string, payload: unknown) => void;
  readonly dispatchRemote: (method: string, args: unknown) => Promise<unknown>;
  /** Accepted for call-site compatibility. This route writes no timestamped rows of its own. */
  readonly now?: () => number;
}) {
  const settings = new SandSettingsStore(join(options.dataDir, "settings.json"));
  const storePath = join(options.dataDir, "inference-router-transcript.json");
  const queues = new Map<string, Promise<unknown>>();

  const load = async (): Promise<Store> => {
    try { return parseInferenceRouterTranscriptStore(JSON.parse(await readFile(storePath, "utf8"))); }
    catch { return EMPTY_STORE; }
  };
  const persist = async (store: Store): Promise<void> => {
    await mkdir(dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, storePath);
  };
  const emitTranscript = (agentId: string, type: "appended" | "updated", entry: Record<string, unknown>) => options.postEvent("transcript", { type, entry, agentId });
  // A consumed control payload is applied, never shown. Only the title is acted on: naming a
  // new agent, or opening a new conversation, from a model-authored payload is a product
  // decision this route does not make on its own. `updateAgent` rewrites the whole profile, so
  // the current name and description have to travel with the title, and a profile that cannot
  // be read or stored must never fail the turn that produced the payload.
  const applyRoutedControlEnvelope = async (agentId: string, envelope: RoutedControlEnvelope): Promise<void> => {
    const title = envelope.title;
    if (title == null) return;
    try {
      const roster = await options.dispatchRemote("listAgents", {});
      if (!Array.isArray(roster)) return;
      const current = asRecord(roster.find(raw => asRecord(raw)?.id === agentId));
      if (current == null || typeof current.name !== "string" || current.name.trim().length === 0) return;
      await options.dispatchRemote("updateAgent", {
        id: agentId,
        profile: {
          name: current.name,
          description: typeof current.description === "string" ? current.description : "",
          title,
        },
      });
    } catch { /* a title that cannot be stored is dropped, not surfaced as an error bubble */ }
  };
  const toggleLocalReaction = async (agentId: string, entryId: string, emoji: string): Promise<Record<string, unknown> | null> => {
    const trimmed = emoji.trim();
    if (agentId.length === 0 || entryId.length === 0 || trimmed.length === 0) return null;
    const current = await load();
    const entries = current.agents[agentId];
    if (entries == null) return null;
    const index = entries.findIndex(entry => entry.id === entryId);
    if (index < 0) return null;
    const before = entries[index]!;
    const reactions = before.reactions ?? [];
    const exists = reactions.some(reaction => reaction.emoji === trimmed && reaction.by === "me");
    const nextReactions = exists ? reactions.filter(reaction => !(reaction.emoji === trimmed && reaction.by === "me")) : [...reactions, { emoji: trimmed, by: "me" }];
    const { reactions: _oldReactions, ...withoutReactions } = before;
    const updated: StoredEntry = nextReactions.length === 0 ? withoutReactions : { ...withoutReactions, reactions: nextReactions };
    const nextEntries = [...entries];
    nextEntries[index] = updated;
    await persist({ schemaVersion: 2, agents: { ...current.agents, [agentId]: nextEntries } });
    return projectInferenceRouterTranscriptEntry(updated);
  };
  // The one concern that is genuinely agent-free is naming the conversation, so it is the
  // only thing this route still asks a model for. The turn itself is the agent's: it is
  // delivered to the box, it runs with the agent's own system prompt and its own toolset, and
  // it reaches the user through `SendMessage` and nothing else.
  //
  // A name is asked for once, while the agent is still untitled, so a title the user or the
  // agent already chose is never overwritten by a fresh guess on every message. Nothing here
  // can fail a turn: no title is an acceptable outcome, and an error is not worth a bubble.
  const nameConversation = async (provider: Exclude<SandInferenceProvider, "cursor">, agentId: string, prompt: string): Promise<void> => {
    const roster = await options.dispatchRemote("listAgents", {});
    if (!Array.isArray(roster)) return;
    const current = asRecord(roster.find(raw => asRecord(raw)?.id === agentId));
    if (current == null || typeof current.name !== "string" || current.name.trim().length === 0) return;
    if (typeof current.title === "string" && current.title.trim().length > 0) return;
    const reply = await runRoutedProviderText(
      provider,
      [{ role: "user", content: `${ROUTED_TITLE_INSTRUCTION}\n\n${prompt.slice(0, ROUTED_TITLE_SOURCE_CHARS)}` }],
      // The conversation is the identity OpenCode Go caches on, and the agent id is stable
      // for the life of the conversation.
      { sessionId: agentId },
    );
    const envelope = parseRoutedControlEnvelope(reply);
    if (envelope == null) return;
    await applyRoutedControlEnvelope(agentId, envelope);
  };

  return {
    provider(): SandInferenceProvider { return settings.getInferenceProvider(); },
    async dispatch(method: string, args: unknown): Promise<{ handled: boolean; value?: unknown }> {
      const provider = settings.getInferenceProvider();
      if (method === "reactToMessage") {
        // Only an entry this route wrote has a reaction stored here, so this claims a reaction
        // for the turns it owned before it stopped answering `sendPrompt` and returns null for
        // everything else. A reaction on an agent's own message is therefore the host's
        // business again, which is what puts it where the agent can read it.
        const record = asRecord(args) ?? {};
        const agentId = typeof record.agentId === "string" ? record.agentId : "";
        const entryId = typeof record.entryId === "string" ? record.entryId : "";
        const emoji = typeof record.emoji === "string" ? record.emoji : "";
        const updated = await toggleLocalReaction(agentId, entryId, emoji);
        if (updated != null) {
          emitTranscript(agentId, "updated", updated);
          return { handled: true, value: undefined };
        }
      }
      if (provider !== "cursor" && ["getAgentTranscriptTail", "openAgentTail", "getAgentTranscriptWindow"].includes(method)) {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.id === "string" ? record.id : "";
        const [remote, local] = await Promise.all([options.dispatchRemote(method, args), load()]);
        const result = asRecord(remote);
        if (result == null || !Array.isArray(result.entries) || agentId.length === 0) return { handled: true, value: remote };
        // Nothing new is written here any more, so `local` only ever holds the turns this
        // route owned before it stopped answering `sendPrompt`. Merging them keeps the
        // conversations the user can still see; every new turn is the box's alone.
        const entries = [...result.entries, ...(local.agents[agentId] ?? []).map(projectInferenceRouterTranscriptEntry)];
        const limit = typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0 ? record.limit : 500;
        return { handled: true, value: { ...result, entries: entries.slice(-limit) } };
      }
      // A prompt typed in the UI belongs to the agent, not to this route. Answering it here
      // replaced the agent with a bare chat completion: the transcript was flattened into
      // role/content pairs, the routed MCP tool list was the only tool source and it is empty
      // on a box with no connectors, so the request went out with no `tools` and a four-line
      // system prompt naming nothing, and the reply was written into the chat as if the agent
      // had sent it. None of that reaches the user any more: the route declines the turn and
      // `dispatchRequest` forwards it to the box, where the runner has its real system
      // prompt, its real toolset and `SendMessage` as the only way to speak.
      if (method !== "sendPrompt" || provider === "cursor") return { handled: false };
      const record = asRecord(args) ?? {};
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      const prompt = typeof record.prompt === "string" ? record.prompt : "";
      // Naming is a side concern, so it is queued behind any earlier naming for the same
      // agent, is never awaited, and cannot turn into an error bubble or a delay. A prompt
      // this route cannot attribute to an agent names nothing at all.
      if (agentId.length > 0 && prompt.length > 0) {
        const previous = queues.get(agentId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(() => nameConversation(provider, agentId, prompt)).catch(() => undefined);
        const queued = next.finally(() => { if (queues.get(agentId) === queued) queues.delete(agentId); });
        queues.set(agentId, queued);
        void queued;
      }
      return { handled: false };
    },
  };
}
