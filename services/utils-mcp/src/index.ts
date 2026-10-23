// A deliberately tiny, generic MCP server — nothing to do with WooCommerce.
// Its job in the platform is to prove two things about the gateway:
//   1. The gateway federates ANY MCP server, not just the store one.
//   2. Running two identical copies (utils_a, utils_b) creates a real tool-name
//      collision (both expose current_time + echo), which the gateway resolves
//      by namespacing — utils_a__current_time vs utils_b__current_time.
//
// Same stateless Streamable-HTTP shape as woo-mcp: a fresh server per request.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const instance = process.env.INSTANCE_ID ?? "a";

function buildServer(): McpServer {
  const server = new McpServer(
    { name: `utils-${instance}`, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool("current_time", {
    description: "Return the current server time as an ISO-8601 string.",
    annotations: { readOnlyHint: true },
    inputSchema: {},
  }, async () => ({
    content: [{ type: "text" as const, text: new Date().toISOString() }],
  }));

  server.registerTool("echo", {
    description: "Echo back the given text (useful for connectivity tests).",
    annotations: { readOnlyHint: true },
    inputSchema: { text: z.string().describe("Text to echo back") },
  }, async (args) => ({
    content: [{ type: "text" as const, text: `[utils-${instance}] ${args.text}` }],
  }));

  return server;
}

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ status: "ok", instance }));

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const methodNotAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`utils-mcp (instance=${instance}) listening on :${port}/mcp`));
