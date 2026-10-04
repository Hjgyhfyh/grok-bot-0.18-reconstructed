import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export class SandGatewayConfigError extends Error {
  constructor(message: string) { super(message); this.name = "SandGatewayConfigError"; }
}

export interface GatewayServerConfig {
  readonly host: string;
  readonly port?: number;
  readonly authToken?: string;
  readonly tls?: { readonly cert: Buffer; readonly key: Buffer };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export function isLoopbackHost(host: string): boolean { return LOOPBACK_HOSTS.has(host.trim().toLowerCase()); }

function readPort(raw: string | undefined): number | undefined {
  if (raw == null || raw.length === 0) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveTls(env: NodeJS.ProcessEnv): GatewayServerConfig["tls"] {
  const certPath = env.SAND_GATEWAY_TLS_CERT?.trim();
  const keyPath = env.SAND_GATEWAY_TLS_KEY?.trim();
  if ((certPath == null || certPath.length === 0) && (keyPath == null || keyPath.length === 0)) return undefined;
  if (certPath == null || certPath.length === 0 || keyPath == null || keyPath.length === 0) {
    throw new SandGatewayConfigError("Gateway TLS needs both SAND_GATEWAY_TLS_CERT and SAND_GATEWAY_TLS_KEY.");
  }
  try { return { cert: readFileSync(certPath), key: readFileSync(keyPath) }; }
  catch (error) { throw new SandGatewayConfigError(`Failed to read gateway TLS cert/key (${certPath}, ${keyPath}): ${String(error)}`); }
}

export function resolveGatewayServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  generateToken: () => string = () => randomBytes(32).toString("base64url")
): GatewayServerConfig {
  const host = env.SAND_GATEWAY_BIND_HOST?.trim() || "127.0.0.1";
  const port = readPort(env.SAND_HOST_PORT);
  const tls = resolveTls(env);
  const pinnedToken = env.SAND_GATEWAY_TOKEN?.trim();
  // Authentication is unconditional. The previous rule asked for a token only
  // when the host was not loopback, when SAND_GATEWAY_REQUIRE_AUTH was set, or
  // when a pinned token already existed. SAND_GATEWAY_BIND_HOST=0.0.0.0 with no
  // pinned token satisfied none of those three, so `authToken` came back
  // undefined, `gateway-server.ts` skipped its bearer check, and every one of
  // the ~124 host commands - setBoxSecrets, setHostSettings, deleteAgents -
  // answered any caller on the LAN. Loopback is not a reason to drop the
  // credential either: the token is what the launcher and the desktop share,
  // and it is read back out of gateway.json.
  const authToken = pinnedToken != null && pinnedToken.length > 0 ? pinnedToken : generateToken();
  return { host, ...(port === undefined ? {} : { port }), authToken, ...(tls === undefined ? {} : { tls }) };
}

export function gatewayScheme(config: GatewayServerConfig): "http" | "https" { return config.tls == null ? "http" : "https"; }
