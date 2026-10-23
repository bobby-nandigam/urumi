// Central config, loaded once from the environment at startup.
//
// Everything the gateway needs to run is an env var so the same image behaves
// differently per environment (local vs prod) purely through Helm values —
// no code change, no rebuild. We validate eagerly and crash loudly if a
// required value is missing, so a misconfigured Deployment fails fast at boot
// instead of erroring on the first request.

export interface UpstreamConfig {
  /** Stable identifier used to namespace this upstream's tools (e.g. "woo_default"). */
  name: string;
  /** Full MCP endpoint URL, e.g. http://woo-mcp-default/mcp */
  url: string;
}

export interface Config {
  port: number;
  /** Postgres connection string (libpq style). */
  databaseUrl: string;
  /** MCP servers this gateway federates. */
  upstreams: UpstreamConfig[];
  /** Per-upstream tool-call timeout in ms (dead/slow upstream protection). */
  upstreamTimeoutMs: number;
  /** Name recorded for the auto-generated bootstrap admin key on first boot. */
  bootstrapKeyName: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function parseUpstreams(raw: string): UpstreamConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`UPSTREAMS is not valid JSON: ${raw}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("UPSTREAMS must be a non-empty JSON array of { name, url }");
  }
  return parsed.map((u, i) => {
    if (!u || typeof u !== "object" || typeof (u as any).name !== "string" || typeof (u as any).url !== "string") {
      throw new Error(`UPSTREAMS[${i}] must be { name: string, url: string }`);
    }
    const name = (u as any).name as string;
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      // Names become part of the namespaced tool id, which MCP restricts to
      // [A-Za-z0-9_-]; we keep names to word chars so "<name>__<tool>" is valid.
      throw new Error(`UPSTREAMS[${i}].name "${name}" must match [A-Za-z0-9_]+`);
    }
    return { name, url: (u as any).url as string };
  });
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    databaseUrl: requireEnv("DATABASE_URL"),
    upstreams: parseUpstreams(requireEnv("UPSTREAMS")),
    upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 15000),
    bootstrapKeyName: process.env.BOOTSTRAP_KEY_NAME ?? "bootstrap-admin",
  };
}
