// Audit log: one row per tool call attempted through the gateway.
//
// We record who called, what tool, which upstream served it, the arguments,
// the outcome (ok / error / denied) and how long it took. Writes are
// best-effort and must never fail a request — observability should not take
// down the data path — so insert errors are logged and swallowed.

import type { Pool } from "pg";
import type { Role } from "./apikeys.js";

export interface AuditEntry {
  apiKeyId: number | null;
  keyName: string | null;
  role: Role | null;
  tool: string;
  upstream: string | null;
  arguments: unknown;
  status: "ok" | "error" | "denied";
  durationMs: number | null;
  error?: string | null;
}

export async function recordAudit(pool: Pool, e: AuditEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log
        (api_key_id, key_name, role, tool, upstream, arguments, status, duration_ms, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        e.apiKeyId,
        e.keyName,
        e.role,
        e.tool,
        e.upstream,
        e.arguments === undefined ? null : JSON.stringify(e.arguments),
        e.status,
        e.durationMs,
        e.error ?? null,
      ],
    );
  } catch (err) {
    console.error("Failed to write audit row (continuing):", err);
  }
}

export interface AuditRow {
  id: number;
  ts: string;
  key_name: string | null;
  role: string | null;
  tool: string;
  upstream: string | null;
  arguments: unknown;
  status: string;
  duration_ms: number | null;
  error: string | null;
}

export async function queryAudit(pool: Pool, limit = 100): Promise<AuditRow[]> {
  const capped = Math.min(Math.max(limit, 1), 500);
  const { rows } = await pool.query<AuditRow>(
    `SELECT id, ts, key_name, role, tool, upstream, arguments, status, duration_ms, error
     FROM audit_log ORDER BY ts DESC LIMIT $1`,
    [capped],
  );
  return rows;
}
