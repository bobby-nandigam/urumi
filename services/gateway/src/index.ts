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
import { buildGatewayServer } from "./mcp.js";
import { buildDashboardRouter } from "./dashboard.js";

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await initSchema(pool);

  // First-boot bootstrap: if there are no keys at all, mint one admin key and
  // print it once. That key is how an operator first reaches the dashboard to
  // create the rest; the plaintext is never stored and never shown again.
  if ((await countActiveKeys(pool)) === 0) {
    const { plaintext } = await createApiKey(pool, config.bootstrapKeyName, "admin");
    console.log(
      `\n${"=".repeat(68)}\n` +
      `  BOOTSTRAP ADMIN KEY (shown ONCE — copy it now):\n` +
      `    ${plaintext}\n` +
      `  Use it as a Bearer token for /api/* and /mcp.\n` +
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
