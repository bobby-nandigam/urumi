// API-key issuance, verification, and the role model.
//
// A key looks like:  urumi_<prefix>_<secret>
//   prefix  = 8 random hex chars, stored in plaintext and UNIQUE-indexed.
//   secret  = 32 random hex chars, NEVER stored.
// We store only bcrypt(full key). To verify a presented key we split off its
// prefix, look up the single row with that prefix, then bcrypt.compare the
// whole key against the stored hash. (bcrypt hashes are not searchable, hence
// the prefix.) The plaintext key is shown to the operator exactly once — at
// creation — and is unrecoverable afterwards, which is the point.

import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";

export type Role = "admin" | "member" | "viewer";
export const ROLES: Role[] = ["admin", "member", "viewer"];

export interface ApiKeyRow {
  id: number;
  name: string;
  prefix: string;
  role: Role;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

// --- Authorization policy -------------------------------------------------
// Roles are intentionally few and easy to defend:
//   admin  — every tool, plus dashboard management (create/revoke keys).
//   member — every tool, but no management.
//   viewer — read-only tools only (tools the upstream marks readOnlyHint).
// Authorization for tools is driven by the tool's own MCP annotation, so the
// gateway never hard-codes which tool names are "safe".

export function canManage(role: Role): boolean {
  return role === "admin";
}

export function canCallTool(role: Role, toolIsReadOnly: boolean): boolean {
  if (role === "viewer") return toolIsReadOnly;
  return true; // admin + member may call everything
}

// --- Issuance -------------------------------------------------------------

export interface IssuedKey {
  row: ApiKeyRow;
  /** Full plaintext key — returned ONCE, never stored. */
  plaintext: string;
}

export async function createApiKey(
  pool: Pool,
  name: string,
  role: Role,
): Promise<IssuedKey> {
  const prefix = `urumi_${randomBytes(4).toString("hex")}`; // 8 hex chars
  const secret = randomBytes(16).toString("hex"); // 32 hex chars
  const plaintext = `${prefix}_${secret}`;
  const key_hash = await bcrypt.hash(plaintext, 10);

  const { rows } = await pool.query<ApiKeyRow>(
    `INSERT INTO api_keys (name, prefix, key_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, prefix, role, created_at, last_used_at, revoked_at`,
    [name, prefix, key_hash, role],
  );
  return { row: rows[0], plaintext };
}

// --- Verification ---------------------------------------------------------

export interface AuthedKey {
  id: number;
  name: string;
  role: Role;
}

/** Returns the authenticated key, or null if the key is unknown/invalid/revoked. */
export async function verifyApiKey(pool: Pool, presented: string): Promise<AuthedKey | null> {
  // presented = urumi_<prefix>_<secret>; the stored prefix is "urumi_<prefix>".
  const parts = presented.split("_");
  if (parts.length !== 3 || parts[0] !== "urumi") return null;
  const prefix = `urumi_${parts[1]}`;

  const { rows } = await pool.query<{ id: number; name: string; role: Role; key_hash: string; revoked_at: string | null }>(
    `SELECT id, name, role, key_hash, revoked_at FROM api_keys WHERE prefix = $1`,
    [prefix],
  );
  const row = rows[0];
  if (!row || row.revoked_at) return null;

  const ok = await bcrypt.compare(presented, row.key_hash);
  if (!ok) return null;

  // Best-effort "last seen" bookkeeping; never block the request on it.
  pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => {});
  return { id: row.id, name: row.name, role: row.role };
}

// --- Management queries ---------------------------------------------------

export async function listApiKeys(pool: Pool): Promise<ApiKeyRow[]> {
  const { rows } = await pool.query<ApiKeyRow>(
    `SELECT id, name, prefix, role, created_at, last_used_at, revoked_at
     FROM api_keys ORDER BY created_at DESC`,
  );
  return rows;
}

/** Soft-delete: revoked keys are kept so the audit log's references stay valid. */
export async function revokeApiKey(pool: Pool, id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function countActiveKeys(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM api_keys WHERE revoked_at IS NULL`,
  );
  return Number(rows[0].n);
}
