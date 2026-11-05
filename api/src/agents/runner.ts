import type Anthropic from "@anthropic-ai/sdk";
import { BetaFallbackState } from "@anthropic-ai/sdk";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { claude, fallbackParams, provider } from "./llm.js";

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema; every property listed in `required`, additionalProperties false (strict tool use). */
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  run(input: any): Promise<unknown>;
}

export interface AgentDef {
  name: string;
  system: string;
  tools: AgentTool[];
  effort: "low" | "medium" | "high";
  /** The same job without a model, for LLM_PROVIDER=offline. Uses `call` so tool calls are recorded the same way. */
  offline(input: string, call: (tool: string, input: unknown) => Promise<any>): Promise<string>;
}

export interface ToolCall { tool: string; input: unknown; result: unknown; error?: string }
export interface AgentResult { agent: string; provider: string; output: string; toolCalls: ToolCall[]; runId: number }

const MAX_TURNS = 12;

export async function runAgent(agent: AgentDef, input: string): Promise<AgentResult> {
  const started = Date.now();
  const toolCalls: ToolCall[] = [];
  const call = async (name: string, toolInput: unknown) => {
    const tool = agent.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool ${name}`);
    try {
      const result = await tool.run(toolInput);
      toolCalls.push({ tool: name, input: toolInput, result });
      return result;
    } catch (e) {
      toolCalls.push({ tool: name, input: toolInput, result: null, error: String((e as Error).message ?? e) });
      throw e;
    }
  };

  let output = "";
  let error: string | null = null;
  try {
    output = provider === "offline" ? await agent.offline(input, call) : await modelLoop(agent, input, call);
  } catch (e) {
    error = String((e as Error).message ?? e);
    output = `The ${agent.name} could not finish: ${error}`;
  }
  const row = await db.query(
    `INSERT INTO agent_runs (agent, provider, input, output, tool_calls, error, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [agent.name, provider === "offline" ? "offline" : `${provider}:${config.CLAUDE_MODEL}`, JSON.stringify({ input }), output,
      JSON.stringify(toolCalls), error, Date.now() - started],
  );
  return { agent: agent.name, provider, output, toolCalls, runId: row.rows[0].id };
}

/** Manual tool-use loop over the beta Messages API (beta for refusal fallbacks). */
async function modelLoop(agent: AgentDef, input: string, call: (tool: string, input: unknown) => Promise<unknown>): Promise<string> {
  const tools: Anthropic.Beta.BetaTool[] = agent.tools.map((t) => ({
    name: t.name, description: t.description, input_schema: t.input_schema, strict: true,
  }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: input }];
  const fallbackState = new BetaFallbackState();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await claude().beta.messages.create(
      {
        model: config.CLAUDE_MODEL,
        max_tokens: 16000,
        system: agent.system,
        tools,
        messages,
        output_config: { effort: agent.effort },
        ...fallbackParams(),
      },
      { fallbackState },
    );

    if (response.stop_reason === "refusal") {
      return `Request declined by the model (${response.stop_details?.category ?? "unspecified"}).`;
    }
    messages.push({ role: "assistant", content: response.content });
    const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();

    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") {
      return response.stop_reason === "max_tokens" ? `${text}\n\n(truncated)` : text;
    }

    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    // Run this turn's tool calls in parallel and return all results in one user message.
    const results = await Promise.all(uses.map(async (u): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
      try {
        return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(await call(u.name, u.input)) };
      } catch (e) {
        return { type: "tool_result", tool_use_id: u.id, content: String((e as Error).message ?? e), is_error: true };
      }
    }));
    messages.push({ role: "user", content: results });
  }
  return "Stopped after the maximum number of steps.";
}

export const schema = (properties: Record<string, unknown>): AgentTool["input_schema"] => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
