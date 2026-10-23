# Deployment

Local (k3d) and production (k3s on a VPS) run the **same charts**. The only
difference is a `values-prod.yaml` overlay per chart.

## Prerequisites

- Docker, [k3d](https://k3d.io), `kubectl`, `helm`, Node 22.
- For the chat agent locally: [Ollama](https://ollama.com) with a tool-capable
  model: `ollama serve` then `ollama pull qwen2.5:3b`.

## Image tags

| Chart | Image | Tag |
|---|---|---|
| woo-mcp | `urumi/woo-mcp` | `0.1.1` |
| gateway | `urumi/gateway` | `0.1.1` |
| dashboard | `urumi/dashboard` | `0.1.0` |
| agent | `urumi/agent` | `0.1.0` |
| utils-mcp | `urumi/utils-mcp` | `0.1.0` |

## Local (k3d)

```bash
# 1. Cluster
k3d cluster create --config infra/k3d-cluster.yaml
kubectl create namespace urumi

# 2. Hostnames (macOS doesn't auto-resolve *.localhost)
echo "127.0.0.1 store.urumi.localhost dashboard.urumi.localhost gateway.urumi.localhost agent.urumi.localhost" \
  | sudo tee -a /etc/hosts

# 3. Build + import each image (k3d has its own containerd; it does not see the
#    host Docker cache, so every image must be imported after building).
build() { (cd services/$1 && npm ci && npm run build >/dev/null 2>&1; docker build -t urumi/$1:$2 .) && k3d image import urumi/$1:$2 -c urumi; }
build woo-mcp 0.1.1
build gateway 0.1.1
build dashboard 0.1.0
build agent 0.1.0
build utils-mcp 0.1.0

# 4. Install
helm install store-default   charts/store     -n urumi
helm install woo-mcp-default charts/woo-mcp    -n urumi
helm install gateway         charts/gateway    -n urumi
helm install dashboard       charts/dashboard  -n urumi
helm install utils-a         charts/utils-mcp  -n urumi --set instance=a
helm install utils-b         charts/utils-mcp  -n urumi --set instance=b

# 5. Bootstrap admin key (printed once)
kubectl logs deploy/gateway -n urumi | grep -A1 "BOOTSTRAP ADMIN KEY"

# 6. Mint a member key for the agent (dashboard → API Keys, or curl /api/keys),
#    then install the agent with it:
helm install agent charts/agent -n urumi --set gatewayApiKey=urumi_<member_key>
```

Open http://dashboard.urumi.localhost:8080 and http://agent.urumi.localhost:8080.

### After a Docker Desktop restart

The k3s API server occasionally comes up in a shutdown loop
(`failed to find interface with specified node ip`). A clean stop/start fixes
it:

```bash
k3d cluster stop urumi && k3d cluster start urumi
```

PVC-backed pods (store, Postgres) take a minute to pass readiness again.

## Production (k3s on a VPS)

Same charts, with `-f charts/<chart>/values-prod.yaml`. Prod prerequisites:

- A container registry the nodes can pull from (set in each `values-prod.yaml`).
- `cert-manager` with a `letsencrypt-prod` ClusterIssuer for Traefik TLS
  (referenced by the ingress annotations in the prod overlays).
- Real DNS A records for `*.urumi.example.com` → the VPS.

```bash
helm upgrade --install store-default charts/store -n urumi \
  -f charts/store/values-prod.yaml \
  --set wordpress.adminPassword=... --set database.password=... \
  --set database.rootPassword=... \
  --set wooApi.consumerKey=ck_... --set wooApi.consumerSecret=cs_...

helm upgrade --install woo-mcp-default charts/woo-mcp -n urumi -f charts/woo-mcp/values-prod.yaml
helm upgrade --install gateway   charts/gateway   -n urumi -f charts/gateway/values-prod.yaml
helm upgrade --install dashboard charts/dashboard -n urumi -f charts/dashboard/values-prod.yaml
helm upgrade --install agent     charts/agent     -n urumi -f charts/agent/values-prod.yaml \
  --set gatewayApiKey=urumi_<member_key>
```

**Secrets** are never committed. Local charts carry dev placeholders; prod
values take real secrets via `--set` (or a sealed-secret / external secret
operator in a real cluster). The gateway's Postgres password is auto-generated
and preserved across upgrades by a Helm `lookup`.

**Prod LLM**: there is no `host.k3d.internal` in prod. Point the agent at a real
endpoint in `charts/agent/values-prod.yaml` — an in-cluster Ollama Service, or a
managed provider once its `LlmProvider` implementation is added.

## Useful checks

```bash
kubectl get pods -n urumi
helm list -n urumi
kubectl logs deploy/gateway -n urumi
# Federated catalog + upstream health (needs an admin key):
kubectl port-forward svc/gateway 18080:80 -n urumi &
curl -s -H "Authorization: Bearer urumi_<admin>" localhost:18080/api/tools
curl -s -H "Authorization: Bearer urumi_<admin>" localhost:18080/api/upstreams
```
