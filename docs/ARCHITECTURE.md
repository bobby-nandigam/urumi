# Architecture

This document explains how each piece works and why it is built the way it is.

## 0. Background: MCP in one paragraph

The [Model Context Protocol](https://modelcontextprotocol.io) is a JSON-RPC
protocol that lets an LLM client discover and call **tools** exposed by a
server. A server advertises tools (`tools/list`) with a name, description, and a
JSON-Schema for their arguments, and runs them (`tools/call`). We use the
**Streamable HTTP** transport (plain HTTP `POST /mcp`) in **stateless** mode: a
fresh server instance per request, no session — which is what lets every MCP
component scale horizontally behind an ordinary Kubernetes Service.

## 1. Store + WooCommerce MCP server

`charts/store` deploys WordPress + WooCommerce + MariaDB. A WP-CLI **setup Job**
installs WooCommerce, seeds demo products, and registers a REST API key.

`services/woo-mcp` is a thin MCP server (one per store) exposing five tools:
`list_products`, `create_product`, `list_orders`, `get_order`,
`update_order_status`. The read-only ones carry `annotations.readOnlyHint: true`
— the gateway uses that to authorize the `viewer` role.

**The in-cluster SSL trick.** WooCommerce only accepts consumer key/secret auth
when `is_ssl()` is true; over plain in-cluster HTTP it would demand OAuth 1.0a.
So the store's setup Job writes an mu-plugin that sets `is_ssl()` true when a
request carries `X-Forwarded-Proto: https`, and woo-mcp sends that header plus
the credentials as a **query string** (Apache strips the `Authorization` header
before PHP). See [the auth note](#) in the repo memory for the full story.

## 2. Gateway (`services/gateway`)

The gateway is the centrepiece. It is **both** an MCP server (to downstream
callers) **and** an MCP client (to upstream servers), with authentication,
authorization, auditing, and a management API in between.

### 2.1 Two planes on one Express app

- `POST /mcp` — the **data plane**. Needs a `Bearer` API key.
- `/api/*` — the **management plane** for the dashboard. Admin key only.
- `/healthz` — liveness/readiness; deliberately does **not** probe Postgres or
  upstreams, so a transient dependency blip never gets the pod killed.

### 2.2 Downstream MCP server — why the low-level API

We build the downstream server with the SDK's **low-level `Server`** and raw
`tools/list` / `tools/call` handlers, not the high-level `McpServer`. A gateway
is a proxy: each upstream already hands us a tool's JSON-Schema `inputSchema`,
and the low-level API lets us pass that schema straight through to the caller.
The high-level API wants a Zod shape, which would force a lossy
JSON-Schema → Zod → JSON-Schema round-trip for every tool.

A fresh server is built **per request**, scoped to the authenticated key, so
`tools/list` only ever returns the tools that key's role may call, and every
call is authorized and audited at this single choke point.

### 2.3 Upstream manager — federation, namespacing, resilience

`src/upstreams.ts` holds one long-lived MCP client per upstream and:

- **Aggregates** every upstream's tools into one list.
- **Namespaces** them as `<upstream>__<tool>` (e.g. `woo_default__list_products`)
  so two upstreams exposing the same tool name never collide. Routing a call
  back to the owning upstream is a prefix match on the known upstream names.
- **Degrades gracefully**: an upstream that is unreachable at boot is logged,
  not fatal; `tools/list` simply omits a failing upstream's tools; and a call to
  a dead upstream applies a **per-call timeout** (`UPSTREAM_TIMEOUT_MS`) and one
  **reconnect retry** before returning a clean error. When the upstream comes
  back, the next call reconnects automatically (`client.onclose` clears the
  cached client).

This is what makes "add more upstreams" a **configuration**, not a code, change.
The upstream set lives in Postgres (seeded once from the `UPSTREAMS` env) and is
editable at runtime via the management API (`POST`/`DELETE /api/upstreams`), so
a newly provisioned store joins the gateway with **no redeploy** — see
[§6 Multi-store provisioning](#6-multi-store-provisioning). The code is entirely
upstream-agnostic.

### 2.4 Authentication, roles, audit

**API keys** look like `urumi_<8hex>_<32hex>`. We store `bcrypt(full key)` plus
a searchable `prefix`. Verification splits the prefix off the presented key,
looks up the one row with that prefix, then `bcrypt.compare`s. The plaintext is
returned exactly once, at creation.

**Roles** are `admin` / `member` / `viewer`:

| Role | Tools | Dashboard management |
|---|---|---|
| admin | all | yes |
| member | all | no |
| viewer | read-only tools only (`readOnlyHint`) | no |

Authorization is driven by the tool's **own annotation**, not a hard-coded list
— so classifying a new tool as safe/unsafe is the upstream's job, not the
gateway's.

**Audit**: every call writes a row to Postgres — key, role, tool, upstream,
arguments, status (`ok`/`error`/`denied`), duration, error. Audit writes are
best-effort and never fail the request.

### 2.5 Postgres schema

```
api_keys(id, name, prefix UNIQUE, key_hash, role, created_at, last_used_at, revoked_at)
audit_log(id, ts, api_key_id, key_name, role, tool, upstream, arguments JSONB,
          status, duration_ms, error)
```

Postgres ships inside the gateway chart (Deployment + PVC + Secret). The
password is generated once via a Helm `lookup` so `helm upgrade` never rotates
it out from under the running gateway. The schema is created idempotently at
startup.

**Bootstrap**: on first boot, if there are no keys, the gateway mints one admin
key and prints it **once** in the logs — enough to reach the dashboard and
create the rest.

## 3. Dashboard (`services/dashboard`)

A Vite + React SPA. The interesting decision is **same-origin**: the browser
only ever talks to `dashboard.urumi.localhost`. nginx serves the static SPA and
**reverse-proxies `/api` to the gateway Service in-cluster**. There is therefore
no CORS to configure and no gateway hostname baked into the frontend bundle.

Sign-in takes an admin key, validates it against `/api/overview`, and keeps it
in `sessionStorage`. Views: Overview (stats + upstream health + recent calls),
API Keys (create-shows-once / revoke), Tools (federated catalog), Audit log.

## 4. Chat agent (`services/agent`)

A natural-language assistant that answers questions about the store by calling
gateway tools.

**Provider-agnostic by design.** The loop depends only on an `LlmProvider`
interface (`chat(messages, tools) → {content, toolCalls}`). Today there is one
implementation, `OllamaProvider`; a Gemini or Anthropic provider is one more
class with no change to the loop.

**The loop** (`src/agent.ts`): list the gateway's tools → ask the LLM → if it
requests tools, execute them **through the gateway** (so they are authorized and
audited) and feed the results back → repeat until the LLM answers in prose or we
hit `MAX_STEPS`. The agent authenticates with its own **member-role** key (least
privilege — it can use tools but cannot manage keys), stored in a Secret.

Locally the LLM is **Ollama** on the developer's Mac, reached from the pod via
`host.k3d.internal:11434` (k3d injects that record into CoreDNS). We use
`qwen2.5:3b` because it supports native tool-calling; Llama 3, phi3, and gemma2
do not (`"does not support tools"`).

## 5. Why k3d locally

k3d runs **k3s** inside Docker — the same distribution as the production VPS
target. Traefik ingress, local-path storage, and the Helm charts are identical;
only `values-prod.yaml` differs. That makes "same charts, config-only
differences" an honest claim rather than a hope.

## 6. Multi-store provisioning

The platform is multi-tenant: every chart is `storeId`-parameterized and the
gateway's upstream list is dynamic (DB-backed, runtime-editable). Provisioning a
new store is `scripts/provision-store.sh <id>`, which:

1. `helm upgrade --install store-<id>` — a fresh WordPress+MariaDB+WooCommerce,
   its own Secret and setup Job (seeds WooCommerce, registers a REST key).
2. `helm upgrade --install woo-mcp-<id>` — a dedicated MCP server wired to that
   store's Service, canonical host, and credentials Secret.
3. `POST /api/upstreams {name:<id>, url:http://woo-mcp-<id>/mcp}` — registers it
   with the running gateway. No gateway restart.

The gateway then exposes that store's tools namespaced `<id>__list_products`,
etc., so one authenticated endpoint fronts every store, and the audit log
attributes each call to the right store via its namespace.
