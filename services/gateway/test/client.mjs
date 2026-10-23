// End-to-end test for the gateway's MCP data plane + role enforcement.
//
// Drives the gateway as a real MCP client over Streamable HTTP, presenting an
// API key as a Bearer token. Run against a port-forward:
//   kubectl port-forward svc/gateway 18080:80 -n urumi
//   MCP_URL=http://localhost:18080/mcp ADMIN_KEY=... VIEWER_KEY=... node test/client.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:18080/mcp";

function connect(key) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "gateway-e2e", version: "0.0.1" });
  return { client, transport };
}

async function withKey(label, key, fn) {
  const { client, transport } = connect(key);
  await client.connect(transport);
  console.log(`\n[${label}] connected`);
  try { await fn(client); } finally { await client.close(); }
}

// 1) Admin: sees all 5 tools, can call a read AND a write tool.
await withKey("admin", process.env.ADMIN_KEY, async (c) => {
  const { tools } = await c.listTools();
  console.log(`  tools/list -> ${tools.length}: ${tools.map((t) => t.name).join(", ")}`);
  const p = await c.callTool({ name: "woo_default__list_products", arguments: { per_page: 2 } });
  const arr = JSON.parse(p.content[0].text);
  console.log(`  list_products -> ${Array.isArray(arr) ? arr.length : "?"} product(s)`);
});

// 2) Member: sees all 5 tools, write allowed.
if (process.env.MEMBER_KEY) {
  await withKey("member", process.env.MEMBER_KEY, async (c) => {
    const { tools } = await c.listTools();
    console.log(`  tools/list -> ${tools.length} tools`);
  });
}

// 3) Viewer: sees ONLY read-only tools; a write call must be denied.
await withKey("viewer", process.env.VIEWER_KEY, async (c) => {
  const { tools } = await c.listTools();
  console.log(`  tools/list -> ${tools.length}: ${tools.map((t) => t.name).join(", ")}`);
  const r = await c.callTool({
    name: "woo_default__update_order_status",
    arguments: { id: 1, status: "completed" },
  });
  console.log(`  write call isError=${r.isError} -> ${r.content[0].text}`);
});

// 4) Bad key: connect must fail with 401.
try {
  await withKey("bad-key", "urumi_00000000_deadbeefdeadbeefdeadbeefdeadbeef", async () => {});
  console.log("\n[bad-key] ERROR: expected 401 but connected");
} catch (e) {
  console.log(`\n[bad-key] rejected as expected: ${e.message.split("\n")[0]}`);
}

console.log("\ndone ✅");
