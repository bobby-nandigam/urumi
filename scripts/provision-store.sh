#!/usr/bin/env bash
# Provision a NEW WooCommerce store and federate it into the gateway — the
# bonus "multi-store provisioning" workflow. End to end it:
#   1. installs the store chart with a fresh storeId (its own WordPress+MariaDB,
#      secret, setup Job that seeds WooCommerce + registers a REST key);
#   2. installs a dedicated woo-mcp for that store (internal MCP server);
#   3. registers it with the gateway via the management API — NO gateway
#      redeploy; the gateway starts namespacing the new store's tools as
#      "<storeId>__<tool>" immediately.
#
# Usage:
#   ADMIN_KEY=urumi_<admin> ./scripts/provision-store.sh <store_id> ["Store Name"]
#
# store_id must be [a-z0-9_]+ (it becomes the gateway upstream name + tool
# namespace, which MCP restricts to word chars).
set -euo pipefail

STORE_ID="${1:?usage: ADMIN_KEY=... provision-store.sh <store_id> [name]}"
STORE_NAME="${2:-Urumi ${STORE_ID} Store}"
NS="${NS:-urumi}"
GATEWAY_SVC="${GATEWAY_SVC:-gateway}"
HOST="store-${STORE_ID}.urumi.localhost"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[[ "$STORE_ID" =~ ^[a-z0-9_]+$ ]] || { echo "store_id must match [a-z0-9_]+"; exit 1; }
: "${ADMIN_KEY:?set ADMIN_KEY to a gateway admin API key}"
command -v openssl >/dev/null || { echo "openssl required"; exit 1; }

CK="ck_$(openssl rand -hex 20)"
CS="cs_$(openssl rand -hex 20)"

echo "==> [1/3] Installing store '${STORE_ID}' (${HOST})"
helm upgrade --install "store-${STORE_ID}" "${ROOT}/charts/store" -n "$NS" \
  --set storeId="${STORE_ID}" \
  --set storeName="${STORE_NAME}" \
  --set ingress.host="${HOST}" \
  --set wooApi.consumerKey="${CK}" \
  --set wooApi.consumerSecret="${CS}"

echo "==> Waiting for WordPress + setup Job (first install pulls WooCommerce; be patient)"
kubectl rollout status "deploy/store-${STORE_ID}-wordpress" -n "$NS" --timeout=300s
kubectl wait --for=condition=complete "job/store-${STORE_ID}-setup" -n "$NS" --timeout=600s

echo "==> [2/3] Installing woo-mcp for '${STORE_ID}'"
helm upgrade --install "woo-mcp-${STORE_ID}" "${ROOT}/charts/woo-mcp" -n "$NS" \
  --set storeId="${STORE_ID}" \
  --set store.serviceHost="store-${STORE_ID}-wordpress" \
  --set store.canonicalHost="${HOST}:8080" \
  --set store.credentialsSecret="store-${STORE_ID}-secret"
kubectl rollout status "deploy/woo-mcp-${STORE_ID}" -n "$NS" --timeout=120s

echo "==> [3/3] Registering upstream '${STORE_ID}' with the gateway"
kubectl port-forward "svc/${GATEWAY_SVC}" 18099:80 -n "$NS" >/tmp/urumi-provision-pf.log 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
for i in $(seq 1 10); do curl -sf http://localhost:18099/healthz >/dev/null 2>&1 && break; sleep 1; done
RESP=$(curl -s -X POST -H "Authorization: Bearer ${ADMIN_KEY}" -H "Content-Type: application/json" \
  -d "{\"name\":\"${STORE_ID}\",\"url\":\"http://woo-mcp-${STORE_ID}/mcp\"}" \
  http://localhost:18099/api/upstreams)
echo "    gateway: ${RESP}"

echo
echo "==> Done. Store '${STORE_ID}' is live and federated."
echo "    Storefront : http://${HOST}:8080   (add '${HOST}' to /etc/hosts to browse)"
echo "    Gateway tools now include: ${STORE_ID}__list_products, ${STORE_ID}__list_orders, ..."
