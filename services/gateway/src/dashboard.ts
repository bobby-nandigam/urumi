// Dashboard REST API (consumed by the React dashboard in Phase 4).
//
// These endpoints are management-plane, so every one requires an *admin* API
// key presented as a bearer token — the same credential system the MCP data
// plane uses, no second auth scheme to reason about. Read endpoints expose the
// federated tool catalog, upstream health, and the audit log; write endpoints
// mint and revoke keys.

import { Router, type Request, type Response, type NextFunction } from "express";
import type { Pool } from "pg";
import {
  ROLES, type Role,
  canManage, verifyApiKey, listApiKeys, createApiKey, revokeApiKey, countActiveKeys,
} from "./apikeys.js";
import { queryAudit } from "./audit.js";
import type { UpstreamManager } from "./upstreams.js";
import { addStoredUpstream, removeStoredUpstream } from "./upstream-store.js";

export function buildDashboardRouter(pool: Pool, manager: UpstreamManager): Router {
  const router = Router();

  // --- admin-only auth gate ---------------------------------------------
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing bearer token" });
    const authed = await verifyApiKey(pool, token);
    if (!authed) return res.status(401).json({ error: "Invalid or revoked API key" });
    if (!canManage(authed.role)) return res.status(403).json({ error: "Admin role required" });
    (req as any).auth = authed;
    next();
  });

  // --- overview (dashboard home) ----------------------------------------
  router.get("/overview", async (_req, res) => {
    const [keys, tools, audit] = await Promise.all([
      countActiveKeys(pool),
      manager.listTools(),
      queryAudit(pool, 5),
    ]);
    res.json({
      activeKeys: keys,
      upstreams: manager.status(),
      toolCount: tools.length,
      recentCalls: audit,
    });
  });

  // --- API keys ----------------------------------------------------------
  router.get("/keys", async (_req, res) => {
    res.json(await listApiKeys(pool));
  });

  router.post("/keys", async (req, res) => {
    const { name, role } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of ${ROLES.join(", ")}` });
    }
    const issued = await createApiKey(pool, name.trim(), role as Role);
    // The plaintext key is returned exactly once; the client must save it now.
    res.status(201).json({ key: issued.plaintext, ...issued.row });
  });

  router.delete("/keys/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });
    const ok = await revokeApiKey(pool, id);
    if (!ok) return res.status(404).json({ error: "key not found or already revoked" });
    res.json({ revoked: id });
  });

  // --- federated catalog + health ---------------------------------------
  router.get("/tools", async (_req, res) => {
    const tools = await manager.listTools();
    res.json(tools.map((t) => ({
      name: t.name,
      upstream: t.upstream,
      originalName: t.originalName,
      description: t.description,
      readOnly: t.readOnly,
    })));
  });

  router.get("/upstreams", (_req, res) => {
    res.json(manager.status());
  });

  // Register a new upstream at runtime — this is how a freshly provisioned
  // store joins the gateway, with no redeploy. Persisted to the DB, then added
  // to the live manager.
  router.post("/upstreams", async (req, res) => {
    const { name, url } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "name is required" });
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "url must be an http(s) URL" });
    if (manager.has(name)) return res.status(409).json({ error: `upstream "${name}" already exists` });
    try {
      await addStoredUpstream(pool, name, url);
      await manager.addUpstream({ name, url });
      res.status(201).json({ name, url });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.delete("/upstreams/:name", async (req, res) => {
    const name = req.params.name;
    const removed = await removeStoredUpstream(pool, name);
    await manager.removeUpstream(name);
    if (!removed) return res.status(404).json({ error: "upstream not found" });
    res.json({ removed: name });
  });

  // --- audit log ---------------------------------------------------------
  router.get("/audit", async (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    res.json(await queryAudit(pool, Number.isFinite(limit) ? limit : 100));
  });

  return router;
}
