// The agent tool loop — the heart of Phase 5.
//
// Given the running conversation, we: list the gateway's tools, ask the LLM
// what to do, and if it requests tools we execute them (through the gateway,
// so they're authorized + audited), feed the results back, and ask again —
// until the LLM answers in plain text or we hit the step cap. This is a
// standard ReAct-style loop; the only Urumi-specific part is that every tool
// runs through the authenticated gateway rather than being called directly.

import type { GatewayClient } from "./gateway.js";
import type { LlmMessage, LlmProvider } from "./llm.js";

const SYSTEM_PROMPT = `You are the Urumi store assistant. You help operators manage a
WooCommerce store by calling the available tools. Rules:
- For anything about live store data (products, orders), ALWAYS call a tool; never guess.
- Tool names are namespaced like "woo_default__list_products" — use them exactly.
- After getting tool results, answer the user concisely in plain language.
- Prices are plain decimal strings in the store's currency.
- If a tool returns an ERROR (e.g. permission denied), explain it plainly; do not retry blindly.`;

export interface ToolStep {
  name: string;
  arguments: Record<string, unknown>;
  result: string;
}

export interface AgentResult {
  answer: string;
  steps: ToolStep[];
}

export async function runAgent(
  provider: LlmProvider,
  gateway: GatewayClient,
  history: LlmMessage[],
  maxSteps: number,
): Promise<AgentResult> {
  const tools = await gateway.listTools();
  const messages: LlmMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  const steps: ToolStep[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const resp = await provider.chat(messages, tools);
    messages.push({ role: "assistant", content: resp.content, toolCalls: resp.toolCalls });

    // No tool requested → the model is answering. We're done.
    if (resp.toolCalls.length === 0) {
      return { answer: resp.content.trim() || "(no answer)", steps };
    }

    // Execute each requested tool and feed the result back as a tool message.
    for (const call of resp.toolCalls) {
      const result = await gateway.callTool(call.name, call.arguments);
      steps.push({ name: call.name, arguments: call.arguments, result });
      // toolName pairs the result for Ollama; toolCallId pairs it for the
      // OpenAI-family (Cloudflare) wire format.
      messages.push({ role: "tool", content: result, toolName: call.name, toolCallId: call.id });
    }
  }

  // Hit the step cap: make one final no-tools pass so the user still gets prose.
  const finalResp = await provider.chat(
    [...messages, { role: "user", content: "Summarise what you found for me now, without calling more tools." }],
    [],
  );
  return { answer: finalResp.content.trim() || "(stopped after too many tool calls)", steps };
}
