// MCP client to the gateway. The agent is just another MCP client: it presents
// its Bearer API key, lists the tools the gateway exposes for that key's role,
// and forwards tool calls. Because authorization + audit live in the gateway,
// the agent inherits them for free — it cannot call anything its key may not.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolSpec } from "./llm.js";

export class GatewayClient {
  private client: Client | null = null;

  constructor(private url: string, private apiKey: string) {}

  private async ensure(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.apiKey}` } },
    });
    const client = new Client({ name: "urumi-agent", version: "0.1.0" });
    client.onclose = () => { if (this.client === client) this.client = null; };
    await client.connect(transport);
    this.client = client;
    return client;
  }

  /** The gateway's tools, shaped for the LLM (JSON Schema passes straight through). */
  async listTools(): Promise<ToolSpec[]> {
    const client = await this.ensure();
    const { tools } = await client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }

  /** Call a tool and return its textual result (or an error string). Never
   *  throws into the loop: a tool error becomes content the model can react to. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      const client = await this.ensure();
      const res = (await client.callTool({ name, arguments: args })) as {
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = (res.content ?? [])
        .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
        .join("\n");
      return res.isError ? `ERROR: ${text}` : text;
    } catch (err) {
      this.client = null; // drop a possibly-dead connection
      return `ERROR: ${(err as Error).message}`;
    }
  }
}
