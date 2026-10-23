// Postgres access + schema bootstrap.
//
// The gateway owns a small amount of durable state: the API keys that
// authenticate callers, and the audit log of every tool call. We keep it in
// Postgres (not in memory) so keys and history survive pod restarts and so the
// Deployment could scale to >1 replica without losing state.
//
// Schema is created idempotently at startup (a tiny "migration"): simpler than
// a migration tool for a project this size, and safe to run on every boot.

// `pg` is a CommonJS module, so under ESM we must default-import the package
// and destructure — `import { Pool } from "pg"` compiles but fails at runtime.
import pg from "pg";
const { Pool } = pg;
type Pool = pg.Pool;

export type Pg = Pool;

export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  // Surface pool-level errors instead of crashing the process silently.
  pool.on("error", (err) => console.error("Postgres pool error:", err));
  return pool;
}

export async function initSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT        NOT NULL,
      -- Public, searchable prefix (e.g. "urumi_ab12cd34"). bcrypt hashes are not
      -- searchable, so we look a key up by this prefix, then verify the hash.
      prefix      TEXT        NOT NULL UNIQUE,
      key_hash    TEXT        NOT NULL,
      role        TEXT        NOT NULL CHECK (role IN ('admin','member','viewer')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at  TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id          BIGSERIAL PRIMARY KEY,
      ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
      api_key_id  BIGINT      REFERENCES api_keys(id) ON DELETE SET NULL,
      key_name    TEXT,                 -- denormalised so history survives key deletion
      role        TEXT,
      tool        TEXT        NOT NULL, -- namespaced tool id, e.g. woo_default__list_products
      upstream    TEXT,                 -- which upstream served it
      arguments   JSONB,
      status      TEXT        NOT NULL CHECK (status IN ('ok','error','denied')),
      duration_ms INTEGER,
      error       TEXT
    );

    CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);

    -- Federated upstreams live in the DB so stores can be provisioned at
    -- runtime (registered via the API) without a gateway redeploy, and the set
    -- survives restarts. The UPSTREAMS env seeds this table on first boot only.
    CREATE TABLE IF NOT EXISTS upstreams (
      name        TEXT        PRIMARY KEY,
      url         TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
