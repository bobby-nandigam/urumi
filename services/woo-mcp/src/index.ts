import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WooClient } from "./woo.js";
import { buildServer } from "./tools.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const storeId = process.env.STORE_ID ?? "default";
const woo = new WooClient({
  baseUrl: requireEnv("WOO_BASE_URL"),
  canonicalHost: requireEnv("WOO_CANONICAL_HOST"),
  consumerKey: requireEnv("WOO_CONSUMER_KEY"),
  consumerSecret: requireEnv("WOO_CONSUMER_SECRET"),
});

const app = express();
app.use(express.json());

// Liveness/readiness: the process is up. (We intentionally do NOT call the store
// here so the MCP server stays "ready" even if the store is briefly down.)
app.get("/healthz", (_req, res) => res.json({ status: "ok", store: storeId }));

// MCP endpoint over Streamable HTTP, stateless: a fresh server + transport per
// request. Stateless means no session affinity, so the Deployment scales freely.
app.post("/mcp", async (req, res) => {
  const server = buildServer(woo, storeId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET/DELETE on /mcp are used by the Streamable HTTP spec for SSE streams and
// session teardown. In stateless mode we don't support those, so answer clearly.
const methodNotAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)" },
    id: null,
  });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`WooCommerce MCP server (store=${storeId}) listening on :${port}/mcp`);
});
