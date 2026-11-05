import Anthropic, { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { config } from "../config.js";

export type Provider = "vertex" | "anthropic" | "offline";

/**
 * Claude client for the agents.
 * - vertex: Claude on Vertex AI (GCP-native; auth is the Cloud Run service account via ADC, no API key).
 *   Refusal fallback runs client-side through the SDK middleware, since Vertex has no server-side `fallbacks`.
 * - anthropic: the Claude API (ANTHROPIC_API_KEY); refusal fallback is server-side (`fallbacks: "default"`).
 * - offline: no model; each agent runs a deterministic policy over the same tools, so the demo works anywhere.
 */
export const provider: Provider = config.LLM_PROVIDER;

let client: Anthropic | AnthropicVertex | null = null;

export function claude(): Anthropic | AnthropicVertex {
  if (client) return client;
  if (provider === "vertex") {
    client = new AnthropicVertex({
      projectId: config.GCP_PROJECT,
      region: config.VERTEX_REGION,
      middleware: [betaRefusalFallbackMiddleware([{ model: config.CLAUDE_FALLBACK_MODEL }])],
    });
  } else if (provider === "anthropic") {
    client = new Anthropic();
  } else {
    throw new Error("LLM_PROVIDER=offline has no model client");
  }
  return client;
}

/** Request fields that differ by provider (server-side fallback exists only on the Claude API). */
export function fallbackParams(): { betas?: Anthropic.Beta.AnthropicBeta[]; fallbacks?: Anthropic.Beta.BetaFallbacksParam } {
  return provider === "anthropic" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};
}
