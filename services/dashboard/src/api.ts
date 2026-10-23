// Thin typed client for the gateway management API (/api/*).
//
// The browser always talks to its OWN origin — nginx (prod) or Vite (dev)
// reverse-proxies /api to the gateway in-cluster — so there is no CORS and no
// gateway hostname baked into the frontend. The admin key is held in memory +
// sessionStorage and sent as a Bearer token on every call.

export type Role = "admin" | "member" | "viewer";

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  role: Role;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CreatedKey extends ApiKey {
  key: string; // plaintext, returned once
}

export interface Upstream {
  name: string;
  url: string;
  connected: boolean;
}

export interface Tool {
  name: string;
  upstream: string;
  originalName: string;
  description?: string;
  readOnly: boolean;
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

export interface Overview {
  activeKeys: number;
  upstreams: Upstream[];
  toolCount: number;
  recentCalls: AuditRow[];
}

const KEY_STORAGE = "urumi.adminKey";

export function getKey(): string {
  try { return sessionStorage.getItem(KEY_STORAGE) ?? ""; } catch { return ""; }
}
export function setKey(k: string): void {
  try { k ? sessionStorage.setItem(KEY_STORAGE, k) : sessionStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getKey()}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* keep */ }
    throw new ApiError(res.status, msg);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  overview: () => req<Overview>("/overview"),
  listKeys: () => req<ApiKey[]>("/keys"),
  createKey: (name: string, role: Role) =>
    req<CreatedKey>("/keys", { method: "POST", body: JSON.stringify({ name, role }) }),
  revokeKey: (id: number) => req<{ revoked: number }>(`/keys/${id}`, { method: "DELETE" }),
  tools: () => req<Tool[]>("/tools"),
  upstreams: () => req<Upstream[]>("/upstreams"),
  audit: (limit = 100) => req<AuditRow[]>(`/audit?limit=${limit}`),
};
