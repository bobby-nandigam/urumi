// Smoke test: drive the WooCommerce MCP server with a real MCP client over
// Streamable HTTP. Lists tools, then calls list_products and list_orders.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:8787/mcp";
const transport = new StreamableHTTPClientTransport(new URL(url));
const client = new Client({ name: "smoke-test", version: "0.0.1" });

await client.connect(transport);
console.log("connected ✅");

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const products = await client.callTool({ name: "list_products", arguments: { per_page: 3 } });
const first = JSON.parse(products.content[0].text);
console.log(`list_products -> ${Array.isArray(first) ? first.length : "?"} product(s); first: ${first[0]?.name} ($${first[0]?.price})`);

const orders = await client.callTool({ name: "list_orders", arguments: { per_page: 3 } });
const ord = JSON.parse(orders.content[0].text);
console.log(`list_orders -> ${Array.isArray(ord) ? ord.length : "?"} order(s)`);

await client.close();
console.log("done ✅");
