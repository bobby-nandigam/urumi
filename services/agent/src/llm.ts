// Provider-agnostic LLM layer.
//
// The agent loop (agent.ts) depends only on the LlmProvider interface and the
// neutral message/tool shapes below. Swapping Ollama for Gemini or Anthropic
// means writing one more class here — the loop never changes.

export interface ToolSpec {
  name: string;
  description?: string;
  /** JSON Schema for the arguments — passed straight from the gateway's tool list. */
  parameters: unknown;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Opaque id from OpenAI-family providers; a tool result must echo it back.
   *  Ollama does not use ids (it pairs by order + tool_name). */
  id?: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant turns that requested tools. */
  toolCalls?: ToolCall[];
  /** On a tool-result message: which tool produced it (Ollama). */
  toolName?: string;
  /** On a tool-result message: the id of the call it answers (OpenAI family). */
  toolCallId?: string;
}

export interface LlmResponse {
  content: string;
  toolCalls: ToolCall[];
}

export interface LlmProvider {
  readonly label: string;
  chat(messages: LlmMessage[], tools: ToolSpec[]): Promise<LlmResponse>;
}

// --- Ollama implementation (native /api/chat tool calling) ----------------

export class OllamaProvider implements LlmProvider {
  readonly label: string;
  constructor(private baseUrl: string, private model: string) {
    this.label = `ollama:${model}`;
  }

  async chat(messages: LlmMessage[], tools: ToolSpec[]): Promise<LlmResponse> {
    const body = {
      model: this.model,
      stream: false,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls
          ? { tool_calls: m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.arguments } })) }
          : {}),
        ...(m.toolName ? { tool_name: m.toolName } : {}),
      })),
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/chat failed: HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      message?: { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] };
      error?: string;
    };
    if (data.error) throw new Error(`Ollama error: ${data.error}`);

    const msg = data.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
      name: tc.function.name,
      // Ollama returns arguments already parsed as an object.
      arguments: tc.function.arguments ?? {},
    }));
    return { content: msg.content ?? "", toolCalls };
  }
}

// --- Cloudflare Workers AI implementation ---------------------------------
// Uses the OpenAI-compatible chat-completions endpoint, so tools and tool_calls
// use the standard OpenAI shape. Unlike Ollama, OpenAI-family tool results must
// reference the tool call's id (toolCallId), which the agent loop threads back.

export class CloudflareProvider implements LlmProvider {
  readonly label: string;
  constructor(private accountId: string, private apiToken: string, private model: string) {
    this.label = `cloudflare:${model}`;
  }

  async chat(messages: LlmMessage[], tools: ToolSpec[]): Promise<LlmResponse> {
    const oaMessages = messages.map((m) => {
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc, i) => ({
            id: tc.id ?? `call_${i}`,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
      }
      if (m.role === "tool") {
        return { role: "tool", tool_call_id: m.toolCallId ?? "call_0", content: m.content };
      }
      return { role: m.role, content: m.content };
    });

    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/v1/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiToken}` },
      body: JSON.stringify({
        model: this.model,
        messages: oaMessages,
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      }),
    });
    if (!res.ok) {
      throw new Error(`Cloudflare chat/completions failed: HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function: { name: string; arguments: string } }[] } }[];
    };
    const msg = data.choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc, i) => {
      let args: Record<string, unknown> = {};
      try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { /* leave empty */ }
      return { id: tc.id ?? `call_${i}`, name: tc.function.name, arguments: args };
    });
    return { content: msg.content ?? "", toolCalls };
  }
}

export interface ProviderOpts {
  provider: string;
  ollamaUrl: string;
  ollamaModel: string;
  cfAccountId: string;
  cfApiToken: string;
  cfModel: string;
}

export function makeProvider(cfg: ProviderOpts): LlmProvider {
  switch (cfg.provider) {
    case "ollama":
      return new OllamaProvider(cfg.ollamaUrl, cfg.ollamaModel);
    case "cloudflare":
      if (!cfg.cfAccountId || !cfg.cfApiToken) {
        throw new Error("cloudflare provider requires CF_ACCOUNT_ID and CF_API_TOKEN");
      }
      return new CloudflareProvider(cfg.cfAccountId, cfg.cfApiToken, cfg.cfModel);
    default:
      throw new Error(`Unknown LLM provider "${cfg.provider}"`);
  }
}
