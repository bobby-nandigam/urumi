// Upstream manager — the gateway's MCP *client* side.
//
// For each configured upstream MCP server we hold one long-lived MCP Client
// (over Streamable HTTP) and reuse it across requests. The manager:
//   * aggregates every upstream's tools into one list, namespaced as
//     "<upstream>__<tool>" so two upstreams exposing the same tool name never
//     collide;
//   * routes a namespaced tool call back to the owning upstream;
//   * applies a per-call timeout and transparently reconnects an upstream that
//     has dropped, so one slow/dead upstream degrades gracefully instead of
//     taking the gateway down.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { UpstreamConfig } from "./config.js";

export interface AggregatedTool {
  /** Namespaced id exposed to downstream clients, e.g. woo_default__list_products. */
  name: string;
  upstream: string;
  originalName: string;
  description?: string;
  inputSchema: unknown;
  /** From the tool's MCP annotations; drives viewer-role authorization. */
  readOnly: boolean;
}

export interface ToolCallResult {
  content: unknown;
  isError?: boolean;
}

const SEP = "__";

interface Entry {
  cfg: UpstreamConfig;
  client: Client | null;
  connecting: Promise<Client> | null;
}

export class UpstreamManager {
  private entries = new Map<string, Entry>();

  constructor(upstreams: UpstreamConfig[], private timeoutMs: number) {
    for (const cfg of upstreams) this.entries.set(cfg.name, { cfg, client: null, connecting: null });
  }

  /** Connect to every upstream at boot. Failures are logged, not fatal: a dead
   *  upstream must not stop the gateway from serving the healthy ones. */
  async connectAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((e) =>
        this.ensureConnected(e).then(
          () => console.log(`Connected to upstream "${e.cfg.name}" at ${e.cfg.url}`),
          (err) => console.warn(`Upstream "${e.cfg.name}" unavailable at boot: ${err.message}`),
        ),
      ),
    );
  }

  /** Lazily (re)establish the MCP client for an upstream, de-duping concurrent
   *  connection attempts so a burst of requests opens only one connection. */
  private ensureConnected(e: Entry): Promise<Client> {
    if (e.client) return Promise.resolve(e.client);
    if (e.connecting) return e.connecting;

    e.connecting = (async () => {
      const client = new Client({ name: "urumi-gateway", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(e.cfg.url));
      // If the underlying connection closes (pod restart), drop the cached
      // client so the next call reconnects instead of using a dead socket.
      client.onclose = () => { if (e.client === client) e.client = null; };
      await client.connect(transport);
      e.client = client;
      return client;
    })();

    // Clear the in-flight promise once settled (success or failure).
    e.connecting.finally(() => { e.connecting = null; }).catch(() => {});
    return e.connecting;
  }

  /** Aggregate tools across all upstreams. Each upstream is queried
   *  independently; an unreachable one contributes nothing but does not fail
   *  the whole listing. */
  async listTools(): Promise<AggregatedTool[]> {
    const all: AggregatedTool[] = [];
    await Promise.all(
      [...this.entries.values()].map(async (e) => {
        try {
          const client = await this.ensureConnected(e);
          const { tools } = await client.listTools();
          for (const t of tools) {
            all.push({
              name: `${e.cfg.name}${SEP}${t.name}`,
              upstream: e.cfg.name,
              originalName: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              readOnly: t.annotations?.readOnlyHint === true,
            });
          }
        } catch (err) {
          console.warn(`listTools failed for upstream "${e.cfg.name}": ${(err as Error).message}`);
          e.client = null; // force reconnect next time
        }
      }),
    );
    return all;
  }

  /** Split a namespaced tool id into (upstream, originalName). Matches by known
   *  upstream prefix so tool names containing "__" are handled correctly. */
  resolve(namespaced: string): { entry: Entry; originalName: string } | null {
    for (const e of this.entries.values()) {
      const p = `${e.cfg.name}${SEP}`;
      if (namespaced.startsWith(p)) return { entry: e, originalName: namespaced.slice(p.length) };
    }
    return null;
  }

  /** Forward a tool call to the owning upstream, with timeout + one reconnect
   *  retry if the cached connection turns out to be dead. */
  async callTool(namespaced: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const resolved = this.resolve(namespaced);
    if (!resolved) throw new Error(`Unknown tool "${namespaced}"`);
    const { entry, originalName } = resolved;

    const attempt = async () => {
      const client = await this.ensureConnected(entry);
      return (await client.callTool(
        { name: originalName, arguments: args },
        undefined,
        { timeout: this.timeoutMs },
      )) as ToolCallResult;
    };

    try {
      return await attempt();
    } catch (err) {
      // A dropped connection surfaces here; reset and retry exactly once.
      entry.client = null;
      try {
        return await attempt();
      } catch (err2) {
        throw new Error(`Upstream "${entry.cfg.name}" call failed: ${(err2 as Error).message}`);
      }
    }
  }

  upstreamNames(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Register a new upstream at runtime (store provisioning) and connect to it
   *  best-effort. Safe to call while serving traffic. */
  async addUpstream(cfg: UpstreamConfig): Promise<void> {
    if (this.entries.has(cfg.name)) throw new Error(`upstream "${cfg.name}" already registered`);
    const entry: Entry = { cfg, client: null, connecting: null };
    this.entries.set(cfg.name, entry);
    await this.ensureConnected(entry).then(
      () => console.log(`Registered + connected upstream "${cfg.name}" at ${cfg.url}`),
      (err) => console.warn(`Registered upstream "${cfg.name}" (not yet reachable: ${err.message})`),
    );
  }

  /** Deregister an upstream at runtime; closes its client. */
  async removeUpstream(name: string): Promise<boolean> {
    const entry = this.entries.get(name);
    if (!entry) return false;
    this.entries.delete(name);
    await entry.client?.close().catch(() => {});
    return true;
  }

  /** Current connection snapshot for the dashboard. "connected" reflects whether
   *  we are holding a live client; a false value self-heals on the next call. */
  status(): { name: string; url: string; connected: boolean }[] {
    return [...this.entries.values()].map((e) => ({
      name: e.cfg.name,
      url: e.cfg.url,
      connected: e.client !== null,
    }));
  }

  async close(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.client?.close().catch(() => {})));
  }
}
