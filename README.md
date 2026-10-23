# Urumi — WooCommerce hosting platform with a team MCP gateway

A small but complete platform that hosts a WooCommerce store on Kubernetes and
puts a **team MCP gateway** in front of it: one authenticated, audited endpoint
that federates any number of upstream [MCP](https://modelcontextprotocol.io)
servers, with a management dashboard and a natural-language chat agent.

Everything runs **in-cluster** on k3s (locally via k3d, so the local distro
matches the production VPS target). Every component ships as a **Helm chart**;
local and production differ only by a `values-prod.yaml` overlay — no template
or code changes between environments.

---

## Architecture

```
                 http://*.urumi.localhost:8080   (Traefik ingress; host :8080 → :80)
                                 │
     ┌──────────────┬───────────┴───────────┬────────────────┐        external MCP
     │              │                        │                │        clients (e.g.
 store.urumi   dashboard.urumi           agent.urumi      gateway.urumi  Claude Desktop)
 (storefront)   (React SPA)              (chat UI)        (/mcp)         │
     │              │  │ /api (nginx proxy)   │ /chat          │  Bearer API key
     ▼              │  └──────────────┐       ▼                ▼  ┌──────────────┐
 ┌──────────┐       │                 └───► ┌─────────────────────▼──┐           │
 │ WordPress│       └───────────────────────►        GATEWAY         │◄──────────┘
 │ +WooComm │   WooCommerce REST            │  MCP server (downstream)│
 │ +MariaDB │◄──(in-cluster HTTP + mu-──┐   │  MCP client  (upstream) │
 └──────────┘    plugin that fakes SSL) │   │  auth · roles · audit   │
                                        │   └──┬──────────┬───────────┘
                                   ┌────┴────┐ │          │
                                   │ woo-mcp │◄┘   ┌───────▼────┐  ┌──────────────┐
                                   │ (1 per  │     │  Postgres  │  │ utils_a /    │
                                   │  store) │     │ keys+audit │  │ utils_b MCP  │
                                   └─────────┘     └────────────┘  └──────────────┘

 Chat agent LLM:  agent → host.k3d.internal:11434 (local Ollama) │ prod → real LLM endpoint
```

**Request planes**

- **MCP data plane** (`POST /mcp` on the gateway): the real work. An MCP client
  presents a `Bearer` API key; the gateway authenticates it, lists the tools the
  key's role may use, and forwards each call to the owning upstream — recording
  an audit row for every call. Stateless Streamable HTTP, so it scales
  horizontally.
- **Management plane** (`/api/*` on the gateway): admin-only REST for the
  dashboard — keys, tools, upstream health, audit log.

## Components

| Component | Dir | Image | Role |
|---|---|---|---|
| Store | `charts/store` | `wordpress`, `mariadb` | WooCommerce storefront + DB |
| WooCommerce MCP | `services/woo-mcp` | `urumi/woo-mcp` | Exposes 5 store tools over MCP (internal) |
| **Gateway** | `services/gateway` | `urumi/gateway` | MCP federation + auth/roles/audit + dashboard API + Postgres |
| Dashboard | `services/dashboard` | `urumi/dashboard` | React SPA; nginx serves it and proxies `/api` to the gateway |
| Chat agent | `services/agent` | `urumi/agent` | Provider-agnostic LLM tool loop over the gateway |
| utils-mcp | `services/utils-mcp` | `urumi/utils-mcp` | Tiny generic MCP server; deployed twice to demo federation + name collisions |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how each plane works and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for local and production deployment.

## Quickstart (local, k3d)

```bash
# 0. Prereqs: Docker, k3d, kubectl, helm, Node 22, and (for the chat agent) Ollama.
# 1. Cluster (host :8080 → Traefik :80)
k3d cluster create --config infra/k3d-cluster.yaml
kubectl create namespace urumi

# 2. Local hostnames (macOS does not auto-resolve *.localhost)
echo "127.0.0.1 store.urumi.localhost dashboard.urumi.localhost gateway.urumi.localhost agent.urumi.localhost" | sudo tee -a /etc/hosts

# 3. Build images + import into k3d (k3d does not share the host Docker cache)
for s in woo-mcp gateway dashboard agent utils-mcp; do
  (cd services/$s && npm ci && docker build -t urumi/$s:0.1.0 .)   # tags vary; see charts
  k3d image import urumi/$s:<tag> -c urumi
done

# 4. Install the charts
helm install store-default  charts/store    -n urumi
helm install woo-mcp-default charts/woo-mcp -n urumi
helm install gateway        charts/gateway  -n urumi
helm install dashboard      charts/dashboard -n urumi
helm install utils-a        charts/utils-mcp -n urumi --set instance=a
helm install utils-b        charts/utils-mcp -n urumi --set instance=b

# 5. Grab the bootstrap admin key the gateway printed once:
kubectl logs deploy/gateway -n urumi | grep -A1 "BOOTSTRAP ADMIN KEY"

# 6. Mint a member key in the dashboard, then install the agent with it:
#    (local chat agent needs Ollama running: `ollama serve` + `ollama pull qwen2.5:3b`)
helm install agent charts/agent -n urumi --set gatewayApiKey=urumi_<member_key>
```

Then open **http://dashboard.urumi.localhost:8080** (sign in with the admin key)
and **http://agent.urumi.localhost:8080** (ask "list the products").

## Multi-store provisioning (bonus)

The platform hosts many stores, not just one. Every chart is `storeId`-
parameterized, and the gateway's upstream list is **dynamic** — stored in
Postgres and editable at runtime through the management API, so a new store
joins the gateway with **no redeploy**.

```bash
ADMIN_KEY=urumi_<admin> ./scripts/provision-store.sh acme "Acme Store"
```

That one command installs a dedicated WordPress+MariaDB+WooCommerce for `acme`,
installs its own `woo-mcp`, and `POST`s to `/api/upstreams` to register it. The
gateway immediately exposes its tools namespaced as `acme__list_products`,
`acme__list_orders`, … alongside every other store's — one authenticated,
audited endpoint over all of them. Deregister with
`DELETE /api/upstreams/acme`.

## Repository layout

```
infra/            k3d cluster config
charts/           one Helm chart per component (+ values-prod.yaml overlays)
services/         source for each container (TypeScript, except the store)
docs/             architecture, deployment, security
```

## Security posture (summary)

- API keys are random, shown once, stored only as **bcrypt hashes** (+ a
  searchable prefix). Three roles (`admin`/`member`/`viewer`); tool access is
  driven by each tool's `readOnlyHint` annotation.
- Every tool call is **audited** to Postgres (who, what, outcome, duration).
- All secrets live in Kubernetes Secrets — none are committed to source.
- Every container runs **non-root** with dropped capabilities; most with a
  read-only root filesystem.

Full detail in [docs/SECURITY.md](docs/SECURITY.md).
