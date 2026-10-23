// Agent service: a tiny chat UI + a stateless /chat endpoint that runs the
// LLM tool loop against the gateway. Stateless means the browser sends the full
// conversation each turn; the server holds no session.

import express from "express";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { makeProvider, type LlmMessage } from "./llm.js";
import { GatewayClient } from "./gateway.js";
import { runAgent } from "./agent.js";

const config = loadConfig();
const provider = makeProvider(config);
const gateway = new GatewayClient(config.gatewayMcpUrl, config.gatewayApiKey);

const app = express();
app.use(express.json({ limit: "256kb" }));

// Serve the static chat page from <cwd>/public (the image places it at
// /app/public; in dev it's the service root's public/).
app.use(express.static(join(process.cwd(), "public")));

app.get("/healthz", (_req, res) => res.json({ status: "ok", provider: provider.label }));

app.post("/chat", async (req, res) => {
  const raw = req.body?.messages;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: "messages must be a non-empty array" });
  }
  // Only user/assistant turns are accepted from the client; the system prompt
  // and tool/assistant-tool turns are managed server-side inside the loop.
  const history: LlmMessage[] = [];
  for (const m of raw) {
    if ((m?.role === "user" || m?.role === "assistant") && typeof m.content === "string") {
      history.push({ role: m.role, content: m.content });
    }
  }
  if (history.length === 0) return res.status(400).json({ error: "no valid user/assistant messages" });

  try {
    const result = await runAgent(provider, gateway, history, config.maxSteps);
    res.json({ ...result, provider: provider.label });
  } catch (err) {
    console.error("Agent error:", err);
    res.status(502).json({ error: `Agent failed: ${(err as Error).message}` });
  }
});

app.listen(config.port, () => {
  console.log(`Urumi agent (${provider.label}) listening on :${config.port}; gateway=${config.gatewayMcpUrl}`);
});
