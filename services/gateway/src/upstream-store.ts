// Persistence for the federated upstream list.
//
// Upstreams live in Postgres (not just the UPSTREAMS env) so a store
// provisioned at runtime is registered with one API call — no gateway redeploy
// — and the registration survives restarts. The env list is only a first-boot
// seed.

import type { Pool } from "pg";
import type { UpstreamConfig } from "./config.js";

const NAME_RE = /^[a-zA-Z0-9_]+$/;

export async function listStoredUpstreams(pool: Pool): Promise<UpstreamConfig[]> {
  const { rows } = await pool.query<UpstreamConfig>(
    `SELECT name, url FROM upstreams ORDER BY created_at`,
  );
  return rows;
}

/** Seed the table from the env list, but only if it is currently empty. After
 *  first boot the DB is the source of truth. */
export async function seedUpstreams(pool: Pool, seed: UpstreamConfig[]): Promise<void> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM upstreams`);
  if (Number(rows[0].n) > 0) return;
  for (const u of seed) {
    await pool.query(`INSERT INTO upstreams (name, url) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING`, [u.name, u.url]);
  }
}

export async function addStoredUpstream(pool: Pool, name: string, url: string): Promise<void> {
  if (!NAME_RE.test(name)) {
    // The name becomes part of the namespaced tool id "<name>__<tool>", which
    // MCP restricts to [A-Za-z0-9_-]; we keep it to word chars.
    throw new Error(`upstream name "${name}" must match [A-Za-z0-9_]+`);
  }
  await pool.query(`INSERT INTO upstreams (name, url) VALUES ($1,$2)`, [name, url]);
}

export async function removeStoredUpstream(pool: Pool, name: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM upstreams WHERE name = $1`, [name]);
  return (rowCount ?? 0) > 0;
}
