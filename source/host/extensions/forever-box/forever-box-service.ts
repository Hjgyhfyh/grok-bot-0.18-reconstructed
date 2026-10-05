import { DeadlineExceededError, type DeadlinePolicy, type ExpiryPolicy, type PollingPolicy, type RetryPolicy } from "../../../internal/scheduling.js";
import { createContext, type Context } from "../../../packages/context/core.js";
import { HostBox, type BoxStatus } from "./host-box.js";

export class SandForeverBoxError extends Error {}
export const RECREATE_UNAVAILABLE_MESSAGE = "Couldn't reach the service that updates this computer. It is unchanged. Try again in a moment; if it keeps failing, the backend may need to be updated.";
/**
 * What `reset()` and `update()` say when the recreate died for want of a credential.
 *
 * `RECREATE_UNAVAILABLE_MESSAGE` above is only true when something can change: a network
 * blip, a busy backend, a half-open socket. All three clear on their own, so "Try again in a
 * moment" is a real instruction there.
 *
 * A missing credential is not one of them. `recreateInBox` reaches `GrokBotService` through
 * the Cursor backend client, whose interceptor calls `auth.getAccessToken` first; with no
 * account that throws `SandCredentialsWaitingError` before any request goes out. Nothing was
 * unreachable -- the computer was never addressed at all. Measured on a live box with no
 * account: `POST /api/updateForeverBox` answered `500` with the sentence above, and the
 * renderer shows it verbatim (`ProductionRenderer.tsx:2019` calls
 * `setNotice(error.message)`), so the user was told to retry a request that can never be
 * sent, and pointed at a backend that cannot be fixed.
 *
 * Matched as text rather than by importing the class, for the reason
 * `electron-main/box/box-host-connector.ts:27-35` gives: this extension does not declare
 * `auth` in its dependency list, and the class lives one extension away. The marker is the
 * shared opening phrase of both credential messages in `auth-service.ts`, which is the only
 * place either is written.
 */
export const RECREATE_CREDENTIAL_REQUIRED_MESSAGE = "Couldn't update the computer: this needs a signed-in Grok Bot account, and this host has none. The computer is unchanged.";
/**
 * The one phrase that says the host has no credential, taken from the opening words of
 * `SAND_SHORTLIVED_CREDS_WAITING_MESSAGE` and `SAND_NO_RENEWAL_CREDENTIAL_MESSAGE` in
 * `host/extensions/auth/auth-service.ts`. Both keep it, so either refusal is recognised.
 */
const CREDENTIAL_WAITING_MARKER = "waiting for an inference credential";
function isCredentialWaitingError(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof Error) {
      if (current.message.toLowerCase().includes(CREDENTIAL_WAITING_MARKER)) return true;
      if (current.cause !== undefined) queue.push(current.cause);
    }
  }
  return false;
}
export const FOREVER_BOX_MIGRATION_TTL_MS = 5 * 60_000; export const FOREVER_BOX_SCREENSHOT_TIMEOUT_MS = 5_000; export const FOREVER_BOX_RECREATE_FLUSH_WAIT_MS = 10_000; export const FOREVER_BOX_IMAGE_WATCH_INTERVAL_MS = 24 * 60 * 60_000; export const FOREVER_BOX_IMAGE_CHECK_TIMEOUT_MS = 30_000;
export interface ForeverBoxOptions { box: HostBox; lifecycleClient: { recreateInBox(options: { preserveData: boolean; force?: boolean }): Promise<{ started: boolean; reason?: string }>; fetchImageUpdateAvailable(signal: AbortSignal): Promise<boolean | undefined> }; trays: { pushError(value: { agentId: string; title: string; detail: string }): void }; telemetry: { reportBoxRecreateDecided(value: Record<string, string>): void; reportBoxImageCheck(value: Record<string, unknown>): void }; imagePolling: PollingPolicy; imagePollingStartDelay: RetryPolicy; imageSeedRetry: RetryPolicy; imageCheckDeadline: DeadlinePolicy; migrationExpiry: ExpiryPolicy; screenshotDeadline: DeadlinePolicy; recreateFlushWaitDeadline: DeadlinePolicy; flushPendingUploads(): Promise<void>; autoUpdateEnabled: boolean; hostBundleAutoUpdateEnabled: boolean; isInBox(): boolean; log(message: string): void; captureScreenshot?(connection: Awaited<ReturnType<HostBox["ensureReady"]>>, signal: AbortSignal): Promise<Uint8Array | null>; ctx?: Context; now?: () => number }
export class ForeverBoxService {
  readonly box: HostBox; readonly isAutoUpdateEnabled: boolean; private readonly ctx: Context; private readonly listeners = new Set<(status: BoxStatus) => void>(); private readonly abort = new AbortController(); private readonly unsubscribeBox: () => void; private imagePolling: { dispose(): void } | undefined; private imagePollingStartDelay: { elapsed: Promise<void>; dispose(): void } | undefined; private migrationExpiry: { dispose(): void } | undefined; private isBusy = false; private updateInFlight = false; private updateFailureNotified = false; private imageRefreshInFlight = false; private migrating = false; private stopped = false; private readonly now: () => number;
  constructor(readonly options: ForeverBoxOptions) { this.box = options.box; this.ctx = options.ctx ?? createContext().withName("foreverBox"); this.now = options.now ?? (() => performance.now()); this.isAutoUpdateEnabled = options.autoUpdateEnabled; this.unsubscribeBox = this.box.subscribe((status) => this.emit(this.decorateStatus(status))); }
  start(): void { void this.seedImageUpdateAvailable(); void this.startImagePolling(); } subscribe(listener: (status: BoxStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); } setBusy(value: boolean): void { this.isBusy = value; }
  async getStatus(input: { id: string }): Promise<BoxStatus> { return this.decorateStatus(await this.box.getStatus(this.ctx, input.id)); }
  async ensure(input: { id: string }): Promise<BoxStatus> { const status = await this.box.ensure(this.ctx, input.id); void this.maybeAutoUpdate(input.id, status.imageUpdateAvailable); return this.decorateStatus(status); }
  reset(input: { id: string }): Promise<BoxStatus> { return this.recreate(input.id, { preserveData: false }); } update(input: { id: string; force?: boolean }): Promise<BoxStatus> { return this.recreate(input.id, { preserveData: true, ...(input.force === undefined ? {} : { force: input.force }) }); }
  async autoUpdateNow(): Promise<{ started: boolean; reason?: string }> { if (!this.options.isInBox()) return { started: false, reason: "not-in-box" }; if (!this.options.autoUpdateEnabled) return { started: false, reason: "auto-update-disabled" }; if (this.isBusy) return { started: false, reason: "busy" }; if (this.updateInFlight) return { started: false, reason: "update-in-flight" }; this.updateInFlight = true; try { const imageCheck = await this.refreshImageUpdateAvailable("pre_hibernation", { coalesce: false }); if (imageCheck.outcome === "failed" || imageCheck.outcome === "timeout") return { started: false, reason: "staleness-check-failed" }; if (imageCheck.available !== true) return { started: false, reason: "no-update-required" }; this.options.telemetry.reportBoxRecreateDecided({ trigger: "hibernation_auto_update", mode: "pod_recreate", preserved: "true" }); try { const result = await this.requestRecreate({ preserveData: true }); if (result.started) this.updateFailureNotified = false; return result; } catch { return { started: false, reason: "recreate-unavailable" }; } } finally { this.updateInFlight = false; } }
  setMigrating(input: { migrating: boolean }): void { this.migrating = input.migrating; this.migrationExpiry?.dispose(); this.migrationExpiry = input.migrating ? this.options.migrationExpiry.arm("migration", () => { this.migrating = false; this.migrationExpiry = undefined; }) : undefined; }
  releaseAgent(agentId: string): Promise<void> { return this.box.releaseWindow(this.ctx, agentId); }
  async captureScreenshot(agentId: string): Promise<Uint8Array | null> { if (this.options.captureScreenshot == null) return null; try { return await this.options.screenshotDeadline.run(async () => this.options.captureScreenshot!(await this.box.ensureReady(this.ctx, agentId), this.abort.signal), this.abort.signal); } catch { return null; } }
  dispose(): void { if (this.stopped) return; this.stopped = true; this.abort.abort(); this.imagePollingStartDelay?.dispose(); this.imagePolling?.dispose(); this.migrationExpiry?.dispose(); this.unsubscribeBox(); this.listeners.clear(); }
  private decorateStatus(status: BoxStatus): BoxStatus { return this.migrating ? { ...status, vncUrl: null, pull: { percent: 0 } } : status; } private emit(status: BoxStatus): void { for (const listener of this.listeners) listener(status); }
  private async recreate(agentId: string, options: { preserveData: boolean; force?: boolean }): Promise<BoxStatus> { let result: { started: boolean; reason?: string }; try { result = await this.requestRecreate(options); } catch (error) { throw new SandForeverBoxError(isCredentialWaitingError(error) ? RECREATE_CREDENTIAL_REQUIRED_MESSAGE : RECREATE_UNAVAILABLE_MESSAGE, { cause: error }); } if (!result.started) throw new SandForeverBoxError(`Couldn't ${options.preserveData ? "update" : "reset"} the computer (${result.reason?.length ? result.reason : "the service declined the recreate"}). It is unchanged.`); this.updateFailureNotified = false; return this.decorateStatus({ agentId, state: "running", vncUrl: null, pull: { percent: 0 } }); }
  private async requestRecreate(options: { preserveData: boolean; force?: boolean }): Promise<{ started: boolean; reason?: string }> { try { await this.options.recreateFlushWaitDeadline.run(() => this.options.flushPendingUploads(), this.abort.signal); } catch (error) { if (this.abort.signal.aborted) throw error; this.options.log(`snapshot upload flush failed before box recreate: ${String(error)}`); } this.abort.signal.throwIfAborted(); return this.options.lifecycleClient.recreateInBox(options); }
  private async maybeAutoUpdate(agentId: string | undefined, available: boolean | undefined): Promise<void> { if (!this.options.autoUpdateEnabled || this.options.hostBundleAutoUpdateEnabled || available !== true || this.isBusy || this.updateInFlight) return; this.updateInFlight = true; this.options.telemetry.reportBoxRecreateDecided({ trigger: "auto_update", mode: "pod_recreate", preserved: "true" }); try { await this.recreate(agentId ?? "", { preserveData: true }); this.updateFailureNotified = false; } catch (error) { this.options.log(`image update failed; computer stays on its current image: ${String(error)}`); if (!this.updateFailureNotified && agentId != null) { this.updateFailureNotified = true; const needsAccount = isCredentialWaitingError(error); this.options.trays.pushError({ agentId, title: "Computer update failed", detail: needsAccount ? "Couldn't move Grok Bot's computer to the latest image. It keeps working on its current image. The update needs a signed-in Grok Bot account, and this host has none, so it will not be retried." : `Couldn't move Grok Bot's computer to the latest image. It keeps working on its current image. Grok Bot will retry, or you can run "Update Grok Bot's Computer" from Settings > Updates.` }); } } finally { this.updateInFlight = false; } }
  async refreshImageUpdateAvailable(trigger: string, options = { coalesce: true }): Promise<{ outcome: string; available?: boolean }> { const startedAt = this.now(); if (!this.options.isInBox()) { this.reportImageCheck({ trigger, outcome: "skipped", durationMs: this.elapsedSince(startedAt), skipReason: "outside_box" }); return { outcome: "skipped" }; } if (options.coalesce && this.imageRefreshInFlight) return { outcome: "skipped" }; if (options.coalesce) this.imageRefreshInFlight = true; try { const available = await this.options.imageCheckDeadline.run((signal) => this.options.lifecycleClient.fetchImageUpdateAvailable(signal), this.abort.signal); this.box.recordImageUpdateAvailable(available); const outcome = available === undefined ? "unanswered" : "answered"; this.reportImageCheck({ trigger, outcome, durationMs: this.elapsedSince(startedAt) }); return { outcome, ...(available === undefined ? {} : { available }) }; } catch (error) { const outcome = this.abort.signal.aborted ? "skipped" : error instanceof DeadlineExceededError ? "timeout" : "failed"; this.reportImageCheck({ trigger, outcome, durationMs: this.elapsedSince(startedAt) }); return { outcome }; } finally { if (options.coalesce) this.imageRefreshInFlight = false; } }
  private async seedImageUpdateAvailable(): Promise<void> { if (!this.options.isInBox()) return; try { await this.options.imageSeedRetry.runWithRetry(async () => { if ((await this.refreshImageUpdateAvailable("seed")).outcome !== "answered") throw new SandForeverBoxError("image state unavailable"); }, this.abort.signal); } catch {} }
  private async startImagePolling(): Promise<void> { this.imagePollingStartDelay = this.options.imagePollingStartDelay.schedule(1, this.abort.signal); try { await this.imagePollingStartDelay.elapsed; } catch { return; } finally { this.imagePollingStartDelay?.dispose(); this.imagePollingStartDelay = undefined; } if (!this.stopped) this.imagePolling = this.options.imagePolling.start(() => this.watchForImageUpdate(), this.abort.signal); }
  private async watchForImageUpdate(): Promise<void> { await this.refreshImageUpdateAvailable("poll"); if (this.options.hostBundleAutoUpdateEnabled || !this.options.autoUpdateEnabled || this.isBusy || this.updateInFlight) return; try { if (!await this.box.isBoxRunning(this.ctx)) return; const agentId = (await this.box.listBoxes()).find((item) => item.running)?.agentId; await this.maybeAutoUpdate(agentId, this.box.getImageUpdateAvailable()); } catch (error) { this.options.log(`image update watch failed: ${String(error)}`); } }
  private reportImageCheck(report: Record<string, unknown>): void { this.options.telemetry.reportBoxImageCheck(report); } private elapsedSince(startedAt: number): number { return Math.max(0, Math.round(this.now() - startedAt)); }
}
