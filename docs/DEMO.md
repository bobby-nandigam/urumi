# Demo video script (~5 minutes)

A scene-by-scene guide for recording the submission video. Each scene lists what
to **show**, what to **say**, and the exact **commands/URLs**. Record in order;
total ≈ 5 min.

## Before you hit record

```bash
# 1. Cluster + everything up
kubectl get pods -n urumi            # all Running/Completed

# 2. Public URLs (Cloudflare Quick Tunnels) — note today's URLs, they change on restart
#    agent      : <AGENT_TUNNEL_URL>
#    dashboard  : <DASHBOARD_TUNNEL_URL>

# 3. Admin key for dashboard login (retrieved from the Secret — no log hunting):
kubectl get secret gateway-admin -n urumi -o jsonpath='{.data.ADMIN_API_KEY}' | base64 -d; echo
```

Have the README architecture diagram open in a tab.

---

## Scene 1 — What it is (0:00–0:30)

**Show:** the README architecture diagram.
**Say:** "Urumi hosts WooCommerce stores on Kubernetes and puts a *team MCP
gateway* in front of them — one authenticated, audited endpoint that federates
many MCP servers, with a dashboard and a chat agent. Everything runs in-cluster
on k3s; same Helm charts local and prod."

## Scene 2 — Dashboard & federation (0:30–1:30)

**Show:** open the **dashboard URL**, log in with the admin key.
- **Overview:** point at upstreams (all connected), tool count, recent calls.
- **Tools tab:** "Every upstream's tools are namespaced — `woo_default__list_products`,
  `acme__list_products`, `utils_a__echo` — so two stores with identical tool
  names never collide."
**Say:** "The gateway is both an MCP server to callers and an MCP client to these
upstreams."

## Scene 3 — Auth, roles, audit (1:30–2:30)

**Show (dashboard → API Keys):** create a key named `demo-viewer`, role **viewer**.
Copy it.
**Show (terminal):** call a *write* tool with the viewer key — it's denied:
```bash
kubectl port-forward svc/gateway 18080:80 -n urumi &
cd services/gateway
MCP_URL=http://localhost:18080/mcp KEY=<viewer-key> \
  node test/call.mjs woo_default__update_order_status '{"id":1,"status":"completed"}'
# -> isError=true: Permission denied: role "viewer" cannot call ...
```
**Show (dashboard → Audit Log):** the `denied` row appears, with role + reason.
**Say:** "Roles are enforced from each tool's own read-only annotation, and every
call — allowed or denied — is audited to Postgres."

## Scene 4 — Chat agent (2:30–3:20)

**Show:** open the **agent URL**, type: *"What products are in the store, with
prices?"*
- Point at the 🔧 tool-call chip (`woo_default__list_products`) then the answer.
**Say:** "The agent runs a provider-agnostic tool loop on **Cloudflare Workers AI**
(`glm-4.7-flash`, free tier). It calls tools *through the gateway*, so it's
authorized and audited like any other client — and it got its gateway key
automatically from a Secret, nothing copy-pasted."

## Scene 5 — Multi-store provisioning bonus (3:20–4:10)

**Show (terminal):** provision a brand-new store live:
```bash
ADMIN_KEY=$(kubectl get secret gateway-admin -n urumi -o jsonpath='{.data.ADMIN_API_KEY}' | base64 -d) \
  ./scripts/provision-store.sh acme2 "Acme Two"
```
**Say (while it runs):** "This installs a fresh WordPress+WooCommerce, its own
MCP server, and registers it with the gateway via the API."
**Show (dashboard → Tools):** refresh — `acme2__*` tools now appear.
**Say:** "No gateway redeploy — upstreams are dynamic, stored in Postgres, so a
new store joins instantly and survives restarts."

## Scene 6 — Resilience (4:10–4:40)

**Show (terminal):**
```bash
kubectl scale deploy/utils-mcp-b -n urumi --replicas=0   # kill an upstream
```
**Show (dashboard → Overview):** `utils_b` flips to **down**, its tools drop, the
rest keep serving.
```bash
kubectl scale deploy/utils-mcp-b -n urumi --replicas=1   # it self-heals
```
**Say:** "A dead upstream degrades gracefully with a per-call timeout, and
self-heals on recovery."

## Scene 7 — Wrap (4:40–5:00)

**Say:** "Everything is Helm — local and prod differ only by a `values-prod.yaml`
overlay with cert-manager TLS. Security: bcrypt-hashed API keys, per-call audit,
non-root containers, secrets only in Kubernetes. Code's on GitHub; the live link
is the tunnel URL above."

---

## Reset to a clean state before recording (optional)

```bash
# remove the demo store/keys you created in a prior take
helm uninstall store-acme2 woo-mcp-acme2 -n urumi 2>/dev/null
# (revoke demo-viewer in the dashboard)
```
