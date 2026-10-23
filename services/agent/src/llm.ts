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
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant turns that requested tools. */
  toolCalls?: ToolCall[];
  /** On a tool-result message: which tool produced it. */
  toolName?: string;
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

export function makeProvider(cfg: { provider: string; ollamaUrl: string; ollamaModel: string }): LlmProvider {
  switch (cfg.provider) {
    case "ollama":
      return new OllamaProvider(cfg.ollamaUrl, cfg.ollamaModel);
    default:
      throw new Error(`Unknown LLM provider "${cfg.provider}"`);
  }
}
