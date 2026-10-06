import { type SandLocalToolPermissionController, type SandLocalToolResolution } from "./local-tool-permission-controller.js";

/**
 * The answer cannot be applied, and the caller has to be told so.
 *
 * The class set no `name`, so it arrived as `Error` and nothing could classify
 * it: `statusForCommandError` has a `400` branch for a request the host read and
 * declined on its own terms, and a refusal raised here is exactly that, but the
 * branch keyed on `instanceof SandGatewayRequestError` and this was not one.
 * Every answer the host declined therefore reached the wire as `500`, which told
 * the caller the server broke and invited a retry of an answer that can never
 * succeed as written. Measured on a live box:
 * `POST /api/resolveLocalToolPermission {"resolution":"yes"}` answered
 * `500 {"error":"Unknown local-tool permission resolution."}`.
 */
export class SandLocalToolPermissionResolutionError extends Error { constructor(message: string) { super(message); this.name = "SandLocalToolPermissionResolutionError"; } }
export function isSandLocalToolPermissionResolution(value: unknown): value is SandLocalToolResolution { return value === "allow-once" || value === "deny" || value === "always" || value === "never"; }

export interface LocalToolPermissionResolutionArgs { readonly agentId: string; readonly entryId: string; readonly requestId: string; readonly resolution: unknown; }
export interface LocalToolPermissionTranscript { readonly widgetResponses: { settleStaleLocalToolPermissionCard(args: { readonly agentId: string; readonly entryId: string; readonly requestId: string }): Promise<boolean | "retired">; expireAllPendingLocalToolPermissionCards?(args: { readonly ifPendingBeforeMs: number }): Promise<void>; }; }

export async function resolveLocalToolPermissionAsk(deps: { readonly asks: SandLocalToolPermissionController; readonly transcript: LocalToolPermissionTranscript; readonly onStrandedRetirement?: () => void }, args: LocalToolPermissionResolutionArgs): Promise<void> {
  const staleError = new SandLocalToolPermissionResolutionError("That local-tool permission request is no longer waiting for an answer.");
  if (!isSandLocalToolPermissionResolution(args.resolution)) throw new SandLocalToolPermissionResolutionError("Unknown local-tool permission resolution.");
  const pending = deps.asks.getPendingRequestById(args.requestId);
  if (pending === undefined) { if (deps.asks.wasSettled(args.requestId)) return; const settle = await deps.transcript.widgetResponses.settleStaleLocalToolPermissionCard({ agentId: args.agentId, entryId: args.entryId, requestId: args.requestId }); if (settle !== false) { if (settle === "retired") deps.onStrandedRetirement?.(); return; } throw staleError; }
  if (pending.agentId !== args.agentId) throw staleError;
  if (deps.asks.resolveRequest(args.requestId, args.resolution) === undefined) throw staleError;
}
