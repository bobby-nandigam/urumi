// Minimal in-cluster Kubernetes client — just enough to upsert one Secret.
//
// On first boot the gateway mints its admin + agent API keys; instead of only
// printing them (forcing an operator to copy-paste), it writes them to a
// Secret. The agent then reads its key straight from that Secret, so the key is
// applied automatically with no human in the loop. Uses the pod's mounted
// ServiceAccount token + CA against the in-cluster API — no extra dependency.

import { readFileSync } from "node:fs";
import https from "node:https";

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";

export function inCluster(): boolean {
  try { readFileSync(`${SA}/token`); return true; } catch { return false; }
}

function request(opts: https.RequestOptions, payload?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Create the Secret, or patch it if it already exists. Secret values are
 *  base64 of the plaintext, per the Kubernetes API. */
export async function upsertSecret(name: string, stringData: Record<string, string>): Promise<void> {
  if (!inCluster()) {
    console.warn(`Not running in-cluster; skipping Secret write for "${name}".`);
    return;
  }
  const ns = readFileSync(`${SA}/namespace`, "utf8").trim();
  const token = readFileSync(`${SA}/token`, "utf8").trim();
  const ca = readFileSync(`${SA}/ca.crt`);
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(stringData)) data[k] = Buffer.from(v).toString("base64");

  const base: https.RequestOptions = {
    host: "kubernetes.default.svc",
    port: 443,
    ca,
    headers: { Authorization: `Bearer ${token}` },
  };

  const createBody = JSON.stringify({ apiVersion: "v1", kind: "Secret", metadata: { name }, data });
  const created = await request(
    { ...base, method: "POST", path: `/api/v1/namespaces/${ns}/secrets`,
      headers: { ...base.headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(createBody) } },
    createBody,
  );
  if (created.status === 201) { console.log(`Wrote Secret "${name}".`); return; }

  if (created.status === 409) {
    const patchBody = JSON.stringify({ data });
    const patched = await request(
      { ...base, method: "PATCH", path: `/api/v1/namespaces/${ns}/secrets/${name}`,
        headers: { ...base.headers, "Content-Type": "application/merge-patch+json", "Content-Length": Buffer.byteLength(patchBody) } },
      patchBody,
    );
    if (patched.status < 300) { console.log(`Updated Secret "${name}".`); return; }
    throw new Error(`Patch Secret "${name}" failed: HTTP ${patched.status} ${patched.body}`);
  }
  throw new Error(`Create Secret "${name}" failed: HTTP ${created.status} ${created.body}`);
}
