// Gateway entrypoint: wires the data plane (authenticated, audited MCP endpoint
// that federates upstream servers) and the management plane (dashboard REST
// API) onto one Express app.

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createPool, initSchema } from "./db.js";
import { verifyApiKey, createApiKey, countActiveKeys } from "./apikeys.js";
import { UpstreamManager } from "./upstreams.js";
import { seedUpstreams, listStoredUpstreams } from "./upstream-store.js";
import { upsertSecret } from "./k8s.js";
import { buildGatewayServer } from "./mcp.js";
import { buildDashboardRouter } from "./dashboard.js";

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await initSchema(pool);

  // First-boot bootstrap: if there are no keys at all, mint the admin key AND a
  // member key for the chat agent, and write both to a Kubernetes Secret
  // ("gateway-admin"). The agent reads its key from that Secret, so the gateway
  // API key is applied automatically — no operator copy-paste. We still log the
  // admin key for first dashboard login (also retrievable from the Secret).
  if ((await countActiveKeys(pool)) === 0) {
    const admin = await createApiKey(pool, config.bootstrapKeyName, "admin");
    const agent = await createApiKey(pool, "chat-agent", "member");
    try {
      await upsertSecret("gateway-admin", {
        ADMIN_API_KEY: admin.plaintext,
        AGENT_API_KEY: agent.plaintext,
      });
    } catch (err) {
      console.error("Could not write bootstrap Secret (keys still valid):", (err as Error).message);
    }
    console.log(
      `\n${"=".repeat(68)}\n` +
      `  BOOTSTRAP KEYS minted and written to Secret "gateway-admin".\n` +
      `  Admin key (dashboard login):\n    ${admin.plaintext}\n` +
      `  Retrieve later with:\n` +
      `    kubectl get secret gateway-admin -n <ns> -o jsonpath='{.data.ADMIN_API_KEY}' | base64 -d\n` +
      `${"=".repeat(68)}\n`,
    );
  }

  // Upstreams: seed the DB from the env list on first boot, then treat the DB
  // as the source of truth (so runtime-provisioned stores persist).
  await seedUpstreams(pool, config.upstreams);
  const stored = await listStoredUpstreams(pool);
  const manager = new UpstreamManager(stored, config.upstreamTimeoutMs);
  await manager.connectAll();

  const app = express();
  app.use(express.json());

  // Liveness/readiness: the process is up. We deliberately do NOT probe
  // upstreams or Postgres here, so a transient upstream blip doesn't get the
  // gateway pod killed; upstream health is its own concern (see /api/upstreams).
  app.get("/healthz", (_req, res) => res.json({ status: "ok", upstreams: manager.upstreamNames() }));

  // Management plane.
  app.use("/api", buildDashboardRouter(pool, manager));

  // Data plane: the authenticated, aggregated MCP endpoint. Stateless Streamable
  // HTTP — a fresh server + transport per request, scoped to the caller's key —
  // so the Deployment can scale horizontally with no session affinity.
  app.post("/mcp", async (req, res) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const authed = token ? await verifyApiKey(pool, token) : null;
    if (!authed) {
      return res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: valid Bearer API key required" },
        id: null,
      });
    }

    const server = buildGatewayServer(manager, pool, authed);
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

  // Stateless mode doesn't use the SSE GET stream or DELETE teardown.
  const methodNotAllowed = (_req: express.Request, res: express.Response) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server)" },
      id: null,
    });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const httpServer = app.listen(config.port, () => {
    console.log(`Urumi gateway listening on :${config.port} (MCP at /mcp, dashboard API at /api)`);
  });

  // Graceful shutdown: stop taking traffic, close upstream clients + DB pool.
  const shutdown = async (sig: string) => {
    console.log(`${sig} received, shutting down...`);
    httpServer.close();
    await manager.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
