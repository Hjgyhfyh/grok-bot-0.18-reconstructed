/**
 * The two error classes the agent lifecycle refuses with, and the one thing
 * that tells them apart.
 *
 * `SandAgentLifecycleError` covers everything an agent command can refuse:
 * a profile that would not build, a group that cannot be duplicated, a delete
 * that lost a race with a file handle. It carries no status, because it says
 * nothing about which of those happened.
 *
 * "That agent id names nothing" is one of those refusals, and it is the one a
 * client acts on differently: `404` says stop asking, `500` says try again. It
 * needs its own class to say so, and it needs to stay a `SandAgentLifecycleError`
 * so every caller that already catches the base class keeps catching it. Making
 * it a sibling instead broke `assert.rejects(..., SandAgentLifecycleError)` in
 * `tests/agent-maintenance-false-success.test.mjs` for the two refusals that
 * have always been there.
 *
 * `SandAgentMissingError` in `session-materialization.ts` is the same answer
 * raised one layer down. It keeps its own name and is listed below, so the status
 * survives the layer boundary without either class importing the other.
 */
export class SandAgentLifecycleError extends Error {}

export class SandAgentNotFoundError extends SandAgentLifecycleError {
  constructor(message: string) {
    super(message);
    this.name = "SandAgentNotFoundError";
  }
}

/**
 * Every error name that means "the agent id names nothing", from any layer.
 * `gateway-server.ts` reads this list, so a new not-found error has to be added
 * here rather than matched by a literal at the HTTP edge.
 */
export const AGENT_NOT_FOUND_ERROR_NAMES: ReadonlySet<string> = new Set([
  "SandAgentNotFoundError",
  "SandAgentMissingError",
]);

export function isAgentNotFoundError(error: unknown): boolean {
  if (error instanceof SandAgentNotFoundError) return true;
  const name = error instanceof Error ? error.name : "";
  return AGENT_NOT_FOUND_ERROR_NAMES.has(name);
}