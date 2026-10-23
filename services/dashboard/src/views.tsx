import { useCallback, useEffect, useState } from "react";
import {
  api, type ApiKey, type AuditRow, type CreatedKey, type Overview, type Role, type Tool,
} from "./api";

// --- small shared data-loading hook --------------------------------------
function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): {
  data: T | null; error: string; loading: boolean; reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true); setError("");
    fn().then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(load, [load]);
  return { data, error, loading, reload: load };
}

function Status({ loading, error }: { loading: boolean; error: string }) {
  if (loading) return <div className="muted pad">Loading…</div>;
  if (error) return <div className="error pad">{error}</div>;
  return null;
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString();

// --- Overview -------------------------------------------------------------
export function OverviewView() {
  const { data, loading, error } = useLoad<Overview>(() => api.overview());
  if (loading || error) return <Status loading={loading} error={error} />;
  const o = data!;
  return (
    <div className="stack">
      <div className="cards">
        <Stat label="Active API keys" value={o.activeKeys} />
        <Stat label="Federated tools" value={o.toolCount} />
        <Stat label="Upstreams" value={o.upstreams.length} />
        <Stat label="Upstreams up" value={o.upstreams.filter((u) => u.connected).length} />
      </div>

      <section className="card">
        <h2>Upstreams</h2>
        <table className="table">
          <thead><tr><th>Name</th><th>URL</th><th>Status</th></tr></thead>
          <tbody>
            {o.upstreams.map((u) => (
              <tr key={u.name}>
                <td className="mono">{u.name}</td>
                <td className="mono muted">{u.url}</td>
                <td><Badge kind={u.connected ? "ok" : "bad"}>{u.connected ? "connected" : "down"}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Recent calls</h2>
        <AuditTable rows={o.recentCalls} compact />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="stat"><div className="stat-value">{value}</div><div className="stat-label">{label}</div></div>;
}

// --- API Keys -------------------------------------------------------------
export function KeysView() {
  const { data, loading, error, reload } = useLoad<ApiKey[]>(() => api.listKeys());
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState("");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setFormErr("");
    try {
      const k = await api.createKey(name.trim(), role);
      setCreated(k); setName(""); reload();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally { setBusy(false); }
  }

  async function revoke(id: number, label: string) {
    if (!confirm(`Revoke key "${label}"? This cannot be undone.`)) return;
    await api.revokeKey(id); reload();
  }

  return (
    <div className="stack">
      <section className="card">
        <h2>Create key</h2>
        <form className="row" onSubmit={create}>
          <input className="input" placeholder="Name (e.g. chat-agent)" value={name}
            onChange={(e) => setName(e.target.value)} />
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">admin — full + manage</option>
            <option value="member">member — all tools</option>
            <option value="viewer">viewer — read-only tools</option>
          </select>
          <button className="btn primary" disabled={busy || !name.trim()}>Create</button>
        </form>
        {formErr && <div className="error">{formErr}</div>}
        {created && (
          <div className="reveal">
            <div className="reveal-label">Copy this key now — it is shown only once:</div>
            <code className="reveal-key">{created.key}</code>
            <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(created.key)}>Copy</button>
            <button className="btn ghost" onClick={() => setCreated(null)}>Dismiss</button>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Keys</h2>
        <Status loading={loading} error={error} />
        {data && (
          <table className="table">
            <thead><tr><th>Name</th><th>Prefix</th><th>Role</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {data.map((k) => (
                <tr key={k.id} className={k.revoked_at ? "dim" : ""}>
                  <td>{k.name}</td>
                  <td className="mono muted">{k.prefix}</td>
                  <td><Badge kind="role">{k.role}</Badge></td>
                  <td className="muted">{fmtTime(k.created_at)}</td>
                  <td className="muted">{k.last_used_at ? fmtTime(k.last_used_at) : "—"}</td>
                  <td>{k.revoked_at ? <Badge kind="bad">revoked</Badge> : <Badge kind="ok">active</Badge>}</td>
                  <td>{!k.revoked_at && <button className="btn danger sm" onClick={() => revoke(k.id, k.name)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// --- Tools ----------------------------------------------------------------
export function ToolsView() {
  const { data, loading, error } = useLoad<Tool[]>(() => api.tools());
  return (
    <section className="card">
      <h2>Federated tools</h2>
      <Status loading={loading} error={error} />
      {data && (
        <table className="table">
          <thead><tr><th>Namespaced name</th><th>Upstream</th><th>Access</th><th>Description</th></tr></thead>
          <tbody>
            {data.map((t) => (
              <tr key={t.name}>
                <td className="mono">{t.name}</td>
                <td className="mono muted">{t.upstream}</td>
                <td><Badge kind={t.readOnly ? "ok" : "warn"}>{t.readOnly ? "read-only" : "write"}</Badge></td>
                <td className="muted">{t.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// --- Audit ----------------------------------------------------------------
export function AuditView() {
  const { data, loading, error, reload } = useLoad<AuditRow[]>(() => api.audit(200));
  return (
    <section className="card">
      <div className="row between">
        <h2>Audit log</h2>
        <button className="btn ghost" onClick={reload}>Refresh</button>
      </div>
      <Status loading={loading} error={error} />
      {data && <AuditTable rows={data} />}
    </section>
  );
}

function AuditTable({ rows, compact }: { rows: AuditRow[]; compact?: boolean }) {
  if (rows.length === 0) return <div className="muted pad">No calls yet.</div>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Time</th><th>Key</th><th>Role</th><th>Tool</th><th>Status</th><th>Duration</th>
          {!compact && <th>Detail</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="muted nowrap">{fmtTime(r.ts)}</td>
            <td>{r.key_name ?? "—"}</td>
            <td className="muted">{r.role ?? "—"}</td>
            <td className="mono">{r.tool}</td>
            <td><Badge kind={r.status === "ok" ? "ok" : r.status === "denied" ? "warn" : "bad"}>{r.status}</Badge></td>
            <td className="muted">{r.duration_ms != null ? `${r.duration_ms} ms` : "—"}</td>
            {!compact && <td className="muted small">{r.error ?? (r.arguments ? JSON.stringify(r.arguments) : "")}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- shared bits ----------------------------------------------------------
function Badge({ kind, children }: { kind: "ok" | "bad" | "warn" | "role"; children: React.ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}
