// The downstream MCP server the gateway exposes to callers (the chat agent,
// Claude Desktop, any MCP client).
//
// We use the LOW-LEVEL Server with raw tools/list + tools/call handlers rather
// than the high-level McpServer. A gateway is a proxy: each upstream already
// gives us a tool's JSON-Schema `inputSchema`, and the low-level API lets us
// pass that schema straight through to the caller, unchanged — no lossy
// JSON-Schema -> zod -> JSON-Schema round-trip.
//
// A fresh server is built per request (stateless Streamable HTTP) and scoped to
// the authenticated key, so tools/list only ever shows what that key's role may
// call, and every call is authorized + audited here at the choke point.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Pool } from "pg";
import type { AuthedKey } from "./apikeys.js";
import { canCallTool } from "./apikeys.js";
import { recordAudit } from "./audit.js";
import type { UpstreamManager } from "./upstreams.js";

export function buildGatewayServer(
  manager: UpstreamManager,
  pool: Pool,
  auth: AuthedKey,
): Server {
  const server = new Server(
    { name: "urumi-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // tools/list — aggregated across upstreams, filtered to the caller's role.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await manager.listTools();
    return {
      tools: tools
        .filter((t) => canCallTool(auth.role, t.readOnly))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as any,
          annotations: { readOnlyHint: t.readOnly },
        })),
    };
  });

  // tools/call — authorize, forward to the owning upstream, audit the outcome.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const started = Date.now();

    const resolved = manager.resolve(name);
    const upstream = resolved?.entry.cfg.name ?? null;

    // Resolve the tool's read-only flag to make the authorization decision.
    // (We re-list rather than trust the caller; cheap and always correct.)
    const known = (await manager.listTools()).find((t) => t.name === name);
    if (!known) {
      await recordAudit(pool, {
        apiKeyId: auth.id, keyName: auth.name, role: auth.role,
        tool: name, upstream, arguments: args, status: "error",
        durationMs: Date.now() - started, error: "unknown tool",
      });
      return { isError: true, content: [{ type: "text", text: `Unknown tool "${name}"` }] };
    }

    if (!canCallTool(auth.role, known.readOnly)) {
      await recordAudit(pool, {
        apiKeyId: auth.id, keyName: auth.name, role: auth.role,
        tool: name, upstream, arguments: args, status: "denied",
        durationMs: Date.now() - started, error: `role "${auth.role}" may not call this tool`,
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Permission denied: role "${auth.role}" cannot call "${name}".` }],
      };
    }

    try {
      const result = await manager.callTool(name, args);
      await recordAudit(pool, {
        apiKeyId: auth.id, keyName: auth.name, role: auth.role,
        tool: name, upstream, arguments: args,
        status: result.isError ? "error" : "ok",
        durationMs: Date.now() - started,
        error: result.isError ? "upstream returned isError" : null,
      });
      return result as any;
    } catch (err) {
      const msg = (err as Error).message;
      await recordAudit(pool, {
        apiKeyId: auth.id, keyName: auth.name, role: auth.role,
        tool: name, upstream, arguments: args, status: "error",
        durationMs: Date.now() - started, error: msg,
      });
      return { isError: true, content: [{ type: "text", text: `Gateway error: ${msg}` }] };
    }
  });

  return server;
}
