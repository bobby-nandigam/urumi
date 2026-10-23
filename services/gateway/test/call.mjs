// Call one gateway tool by name. Usage:
//   MCP_URL=... KEY=... node test/call.mjs <toolName> '<jsonArgs>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:18080/mcp";
const key = process.env.KEY;
const [, , tool, argsJson] = process.argv;
const args = argsJson ? JSON.parse(argsJson) : {};

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${key}` } },
});
const client = new Client({ name: "call", version: "0.0.1" });
await client.connect(transport);
const res = await client.callTool({ name: tool, arguments: args });
console.log(`${tool} -> isError=${res.isError ?? false}: ${res.content.map((c) => c.text).join(" ")}`);
await client.close();
