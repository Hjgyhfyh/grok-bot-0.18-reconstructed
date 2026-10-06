import { randomUUID } from "node:crypto";

import type { Clock, IdleWatchdogPolicy } from "../../../internal/scheduling.js";
import { DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES, SAND_LOCAL_EXEC_LIVENESS_WINDOW_MS, SAND_NO_LOCAL_MACHINE_MESSAGE, sandComputerUnavailableMessage } from "../../../shared/local-exec-gateway.js";
import { SandLocalExecError } from "./local-exec-error.js";

export const SUPERVISED_RANK = 4;
export const VARIANT_RANKS: Readonly<Record<string, number>> = { sand: 2, "sand-lab": 1 };
export const TELEMETRY_VARIANTS = new Set(["sand", "sand-lab", "sand-dev"]);
export const DEFAULT_SAND_COMPUTER_ID = "this-computer";

export interface LocalExecBridgeContext { readonly signal: AbortSignal; readonly agentId?: string; }
export interface LocalExecComputer { readonly id: string; readonly label: string; readonly connected: boolean; }
export interface LocalExecProviderInfo { readonly localRoot: string; readonly terminalsFolder: string; }
export interface LocalExecBridgeFrame { readonly kind: string; readonly requestId?: string; readonly [key: string]: unknown; }
export interface LocalExecProviderReport { readonly phase: "registered" | "detached" | "hello"; readonly providerId: string; readonly providerCount: number; readonly [key: string]: unknown; }
export interface LocalExecRefusedReport { readonly cause: "no_providers" | "computer_unknown" | "stale_heartbeat"; readonly site: string; readonly providerCount: number; readonly liveProviderCount: number; readonly everRegistered: boolean; readonly [key: string]: unknown; }
export interface LocalExecBridgeDeps {
  readonly clock: Clock; readonly responseWatchdog: IdleWatchdogPolicy; readonly blockedReason: () => string | undefined;
  readonly report?: { readonly provider?: (report: LocalExecProviderReport) => void; readonly refused?: (report: LocalExecRefusedReport) => void };
  readonly randomId?: () => string;
}

class FrameQueue implements AsyncIterable<LocalExecBridgeFrame> {
  private readonly buffer: LocalExecBridgeFrame[] = []; private wake: (() => void) | undefined; private closed = false;
  push(frame: LocalExecBridgeFrame): void { if (this.closed) return; this.buffer.push(frame); this.wake?.(); this.wake = undefined; }
  close(): void { this.closed = true; this.wake?.(); this.wake = undefined; }
  async *[Symbol.asyncIterator](): AsyncIterator<LocalExecBridgeFrame> { for (;;) { const frame = this.buffer.shift(); if (frame !== undefined) { yield frame; continue; } if (this.closed) return; await new Promise<void>((resolve) => { this.wake = resolve; }); } }
}

interface Provider {
  readonly id: string; readonly send: (frame: LocalExecBridgeFrame) => void; readonly registeredAt: number;
  lastSeenAt: number; hasHeartbeat: boolean; info?: LocalExecProviderInfo; computerId?: string; label?: string; supervised?: boolean; variant?: string;
}

export function localExecProviderRank(signals: { readonly supervised?: boolean; readonly variant?: string }): number { return (signals.supervised === true ? SUPERVISED_RANK : 0) + (signals.variant == null ? 0 : VARIANT_RANKS[signals.variant] ?? 0); }
export function boundedLocalExecVariant(variant: string | undefined): string | undefined { return variant === undefined ? undefined : TELEMETRY_VARIANTS.has(variant) ? variant : "unknown"; }

export class SandLocalExecBridge {
  private readonly providers = new Set<Provider>(); private readonly byId = new Map<string, Provider>(); private readonly pending = new Map<string, FrameQueue>(); private everRegistered = false; private emptySince: number;
  constructor(private readonly deps: LocalExecBridgeDeps) { this.emptySince = deps.clock.now(); }
  registerProvider(send: (frame: LocalExecBridgeFrame) => void): () => void {
    const provider: Provider = { id: this.deps.randomId?.() ?? randomUUID(), send, registeredAt: this.deps.clock.now(), lastSeenAt: this.deps.clock.now(), hasHeartbeat: false };
    this.providers.add(provider); this.byId.set(provider.id, provider); this.everRegistered = true; this.deps.report?.provider?.({ phase: "registered", providerId: provider.id, providerCount: this.providers.size });
    try { send({ kind: "welcome", providerId: provider.id }); } catch {}
    return () => { if (!this.providers.delete(provider)) return; this.byId.delete(provider.id); const now = this.deps.clock.now(); if (this.providers.size === 0) this.emptySince = now; this.deps.report?.provider?.({ phase: "detached", providerId: provider.id, providerCount: this.providers.size, ageMs: now - provider.registeredAt, hadHello: provider.info !== undefined, hasHeartbeat: provider.hasHeartbeat, wasLive: this.isLive(provider, now), emptied: this.providers.size === 0 }); };
  }
  hasProvider(): boolean { return this.providers.size > 0; }
  isComputerLive(computerId: string): boolean { return this.resolveProvider(computerId) !== undefined; }
  assertComputerAvailable(computerId: string | undefined, gate: { readonly site: string; readonly agentId?: string }): void { this.requireProvider(computerId, gate); }
  checkLiveComputerForAsk(agentId?: string): boolean { if (this.resolveProvider(undefined) !== undefined) return true; this.reportRefused(this.providers.size === 0 ? "no_providers" : "stale_heartbeat", { site: "ask_gate", ...(agentId === undefined ? {} : { agentId }) }); return false; }
  private requireProvider(computerId: string | undefined, gate: { readonly site: string; readonly agentId?: string }): Provider { const provider = this.resolveProvider(computerId); if (provider !== undefined) return provider; if (this.providers.size === 0) { this.reportRefused("no_providers", gate); throw new SandLocalExecError(SAND_NO_LOCAL_MACHINE_MESSAGE); } if (computerId !== undefined && !this.hasComputerId(computerId)) { this.reportRefused("computer_unknown", gate); throw new SandLocalExecError(SAND_NO_LOCAL_MACHINE_MESSAGE); } this.reportRefused("stale_heartbeat", gate); throw new SandLocalExecError(sandComputerUnavailableMessage(this.routeLabel(computerId))); }
  private reportRefused(cause: LocalExecRefusedReport["cause"], gate: { readonly site: string; readonly agentId?: string }): void { this.deps.report?.refused?.({ cause, site: gate.site, ...(gate.agentId === undefined ? {} : { conversationId: gate.agentId }), providerCount: this.providers.size, liveProviderCount: this.liveProviders().length, everRegistered: this.everRegistered, ...(cause === "no_providers" ? { emptyForMs: this.deps.clock.now() - this.emptySince } : {}) }); }
  private providerComputerId(provider: Provider): string { return provider.computerId ?? DEFAULT_SAND_COMPUTER_ID; }
  private isLive(provider: Provider, now = this.deps.clock.now()): boolean { return !provider.hasHeartbeat || now - provider.lastSeenAt <= SAND_LOCAL_EXEC_LIVENESS_WINDOW_MS; }
  private liveProviders(): Provider[] { const now = this.deps.clock.now(); return [...this.providers].filter((provider) => this.isLive(provider, now)); }
  private best(candidates: readonly Provider[]): Provider | undefined { let best: Provider | undefined; for (const provider of candidates) { if (best === undefined || localExecProviderRank(provider) > localExecProviderRank(best) || (localExecProviderRank(provider) === localExecProviderRank(best) && provider.lastSeenAt >= best.lastSeenAt)) best = provider; } return best; }
  listComputers(): LocalExecComputer[] { const now = this.deps.clock.now(); const byComputerId = new Map<string, Provider>(); for (const provider of this.providers) { const id = this.providerComputerId(provider); const existing = byComputerId.get(id); if (existing === undefined || provider.lastSeenAt >= existing.lastSeenAt) byComputerId.set(id, provider); } return [...byComputerId].map(([id, provider]) => ({ id, label: provider.label ?? "this computer", connected: this.isLive(provider, now) })); }
  activeComputer(): LocalExecComputer | undefined { const provider = this.resolveProvider(undefined); return provider === undefined ? undefined : { id: this.providerComputerId(provider), label: provider.label ?? "this computer", connected: true }; }
  private hasComputerId(id: string): boolean { return [...this.providers].some((provider) => this.providerComputerId(provider) === id); }
  private routeLabel(computerId?: string): string | undefined { if (computerId !== undefined) return [...this.providers].find((provider) => this.providerComputerId(provider) === computerId)?.label ?? computerId; return this.best([...this.providers])?.label; }
  private resolveProvider(computerId?: string): Provider | undefined { const live = this.liveProviders(); return computerId === undefined ? this.best(live) : this.best(live.filter((provider) => this.providerComputerId(provider) === computerId)); }
  getProviderInfo(): LocalExecProviderInfo | undefined { return (this.resolveProvider(undefined) ?? [...this.providers].at(-1))?.info; }
  submitResponses(batch: { readonly providerId?: string; readonly frames?: readonly LocalExecBridgeFrame[] }): void {
    const provider = this.providerForBatch(batch.providerId);
    // WHAT AN UNATTRIBUTED BATCH IS ALLOWED TO DO. A batch with no `providerId`
    // is what the shipped desktop sends before it has read its own `welcome`
    // frame - `SandLocalExecProvider.streamRequests` posts `hello` at
    // `local-exec-provider.ts:116` and only fills `this.providerId` in from the
    // stream afterwards, and its `finally` sets the field back to `undefined`
    // when the stream drops - so the first `hello` and the first `ping` of every
    // connect carry no id at all. Those are credited to the most recently
    // registered desktop, and that credit is limited on purpose: it may describe
    // a desktop that has not described ITSELF yet, and nothing else.
    //
    // WHY THE LIMIT. The fallback used to be unconditional, so any batch that
    // named no desktop - or named one that had already disconnected - was
    // applied to whichever desktop registered last. Measured through the real
    // gateway with the real provider class on the wire: an unattributed `ping`
    // flipped a desktop that had been silent for longer than the 30 s liveness
    // window back to `connected:true`, and an unattributed `hello` replaced the
    // one live desktop with `{id:"pc-GHOST", label:"GHOST"}` and
    // `getProviderInfo()` pointing at a `localRoot` no daemon on this machine
    // had ever declared. Every later read, upload and download resolves its path
    // against that root. An `hello` or a `ping` from a sender we cannot name is
    // therefore refused for any desktop that has already named itself.
    //
    // ANSWERS ARE STILL DELIVERED. Only identity and heartbeat are gated. A
    // `client`, `control` or `file` frame carries a `requestId`, is delivered by
    // it, and is delivered whether or not the batch named a desktop that is
    // still here: a desktop that loses its stream in the middle of a command is
    // ordinary, and the host is holding that command open. Gating the identity
    // must not turn a late answer into a hung turn.
    const mayDescribe = provider !== undefined && (batch.providerId !== undefined || provider.info === undefined);
    for (const frame of batch.frames ?? []) {
      if (frame.kind === "hello") { if (provider !== undefined && mayDescribe && typeof frame.localRoot === "string" && typeof frame.terminalsFolder === "string") { const rehello = provider.info !== undefined; provider.info = { localRoot: frame.localRoot, terminalsFolder: frame.terminalsFolder }; if (typeof frame.computerId === "string" && frame.computerId.length > 0) provider.computerId = frame.computerId; if (typeof frame.label === "string" && frame.label.length > 0) provider.label = frame.label; if (typeof frame.supervised === "boolean") provider.supervised = frame.supervised; if (typeof frame.variant === "string" && frame.variant.length > 0) provider.variant = frame.variant; provider.lastSeenAt = this.deps.clock.now(); const variant = boundedLocalExecVariant(provider.variant); this.deps.report?.provider?.({ phase: "hello", providerId: provider.id, providerCount: this.providers.size, helloDelayMs: provider.lastSeenAt - provider.registeredAt, computerIdPresent: provider.computerId !== undefined, rehello, ...(provider.supervised === undefined ? {} : { supervised: provider.supervised }), ...(variant === undefined ? {} : { variant }) }); } continue; }
      if (frame.kind === "ping") { if (provider !== undefined && mayDescribe) { provider.hasHeartbeat = true; provider.lastSeenAt = this.deps.clock.now(); if (typeof frame.supervised === "boolean") provider.supervised = frame.supervised; } continue; }
      if (typeof frame.requestId === "string") this.pending.get(frame.requestId)?.push(frame);
    }
  }
  /**
   * Which desktop sent this batch.
   *
   * A batch that named a desktop is that desktop's and nobody else's. It used to
   * be `(lookup ?? mostRecentlyRegistered)`, so a batch naming a desktop that
   * had disconnected was answered by handing it to a different one - see the
   * limit `submitResponses` places on an unattributed batch for the other half
   * of this. A batch that named nobody keeps the fallback, because that is the
   * only shape the shipped desktop sends before it has read its welcome.
   */
  private providerForBatch(providerId?: string): Provider | undefined { return providerId === undefined ? [...this.providers].at(-1) : this.byId.get(providerId); }
  retireApproval(approvalId: string): void { for (const provider of this.providers) { try { provider.send({ kind: "retire-approval", requestId: this.deps.randomId?.() ?? randomUUID(), approvalId }); } catch {} } }
  async *request(context: LocalExecBridgeContext, frame: LocalExecBridgeFrame, computerId?: string, options?: { readonly watchResponse?: boolean }): AsyncGenerator<LocalExecBridgeFrame> {
    const blocked = this.deps.blockedReason(); if (blocked !== undefined) throw new SandLocalExecError(blocked); const provider = this.requireProvider(computerId, { site: frame.kind, ...(context.agentId === undefined ? {} : { agentId: context.agentId }) }); const requestId = this.deps.randomId?.() ?? randomUUID(); const queue = new FrameQueue(); this.pending.set(requestId, queue);
    const sendCancel = () => { try { provider.send({ kind: "cancel", requestId }); } catch {} }; const onAbort = () => { sendCancel(); queue.close(); }; if (context.signal.aborted) onAbort(); else context.signal.addEventListener("abort", onAbort, { once: true }); let timedOut = false; let responseWatchdog: ReturnType<IdleWatchdogPolicy["arm"]> | undefined;
    const armResponseWatchdog = () => { if (options?.watchResponse !== true) return; if (responseWatchdog === undefined) responseWatchdog = this.deps.responseWatchdog.arm(() => { timedOut = true; sendCancel(); queue.close(); }); else responseWatchdog.kick(); };
    try {
      // The bridge's id is written LAST, and that order is load-bearing.
      // `LocalExecBridgeFrame` declares `requestId?: string` on the frame, so a
      // caller may set it, and this used to be `{ requestId, ...frame }` — which
      // let the caller's field win. The request then went out under one id and
      // registered its queue under another, so the answer arrived for a key the
      // bridge had no waiter for: the generator never yielded, never returned and
      // never threw. Measured against this class, a frame carrying
      // `requestId:"caller-chosen"` received nothing at all, and two concurrent
      // frames sharing one `requestId` left 0 of 2 requests answered, because
      // `pending` holds one queue per id and the first generator's `finally`
      // deletes the second's entry. Spreading the caller's frame first and
      // stamping the generated id last is what makes the wire and the queue
      // agree; nothing else about the frame is touched.
      provider.send({ ...frame, requestId }); armResponseWatchdog(); for await (const response of queue) { armResponseWatchdog(); yield response; } if (timedOut) throw new SandLocalExecError(sandComputerUnavailableMessage(provider.label)); }
    finally { responseWatchdog?.dispose(); this.pending.delete(requestId); queue.close(); context.signal.removeEventListener("abort", onAbort); if (!context.signal.aborted) sendCancel(); }
  }
}
