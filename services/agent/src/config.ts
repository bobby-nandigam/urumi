// Agent config from the environment (Helm-driven, like every other service).
//
// The agent is deliberately provider-agnostic: LLM_PROVIDER selects the
// implementation, and the rest of the code only ever sees the LlmProvider
// interface. Today we ship an Ollama provider; a Gemini/Anthropic one would be
// a drop-in with no change to the tool loop.

export interface Config {
  port: number;
  /** Which LLM backend to use. */
  provider: "ollama";
  ollamaUrl: string;
  ollamaModel: string;
  /** The gateway's MCP endpoint (data plane). */
  gatewayMcpUrl: string;
  /** Member-role API key the agent uses to authenticate to the gateway. */
  gatewayApiKey: string;
  /** Max tool-call rounds before we stop, so a confused model can't loop forever. */
  maxSteps: number;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    provider: (process.env.LLM_PROVIDER ?? "ollama") as "ollama",
    ollamaUrl: process.env.OLLAMA_URL ?? "http://host.k3d.internal:11434",
    ollamaModel: process.env.OLLAMA_MODEL ?? "qwen2.5:3b",
    gatewayMcpUrl: process.env.GATEWAY_MCP_URL ?? "http://gateway/mcp",
    gatewayApiKey: requireEnv("GATEWAY_API_KEY"),
    maxSteps: Number(process.env.MAX_STEPS ?? 6),
  };
}
