import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { safeEqual } from "../lib/crypto.js";
import { listCampaigns } from "../lib/campaigns.js";
import { activate, applyRecommendation, createDraft, pause } from "../lib/campaignService.js";
import { campaignStats, dailySeries } from "../lib/metrics.js";
import { shopify, DEMO_SHOP } from "../shopify/client.js";
import { AGENTS } from "../agents/agents.js";
import { runAgent } from "../agents/runner.js";
import { provider } from "../agents/llm.js";

const Draft = z.object({
  shopDomain: z.string().default(DEMO_SHOP),
  name: z.string().min(1).max(120),
  headline: z.string().min(1).max(60),
  body: z.string().min(1).max(140),
  cta: z.string().min(1).max(24),
  discountPercent: z.number().int().min(1).max(90),
  codePrefix: z.string().max(12).optional(),
  theme: z.record(z.string(), z.string()).optional(),
});

/** Merchant dashboard API. Demo auth: one bearer token (in production: Shopify session tokens from App Bridge). */
export async function adminRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!safeEqual(token, config.ADMIN_TOKEN)) return reply.code(401).send({ error: "unauthorized" });
  });

  app.get("/admin/overview", async () => ({
    provider,
    model: provider === "offline" ? null : config.CLAUDE_MODEL,
    campaigns: await listCampaigns(),
    stats: await campaignStats(),
    series: await dailySeries(14),
  }));

  app.get("/admin/signups", async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 50), 200);
    return (
      await db.query(
        `SELECT s.id, s.email, s.phone, s.sms_consent, s.code, s.abuse_score, s.abuse_status, s.created_at,
                d.status AS code_status, d.order_total_cents
         FROM signups s LEFT JOIN discount_codes d ON d.shop_domain = s.shop_domain AND d.code = s.code
         ORDER BY s.id DESC LIMIT $1`,
        [limit],
      )
    ).rows;
  });

  app.post("/admin/campaigns", async (req) => createDraft(Draft.parse(req.body)));
  app.post("/admin/campaigns/:id/activate", async (req) => activate(shopify, (req.params as { id: string }).id));
  app.post("/admin/campaigns/:id/pause", async (req) => {
    await pause((req.params as { id: string }).id);
    return { ok: true };
  });

  app.get("/admin/recommendations", async () =>
    (await db.query("SELECT * FROM offer_recommendations ORDER BY id DESC LIMIT 20")).rows);
  app.post("/admin/recommendations/:id/apply", async (req) =>
    applyRecommendation(shopify, Number((req.params as { id: string }).id)));
  app.post("/admin/recommendations/:id/dismiss", async (req) => {
    await db.query("UPDATE offer_recommendations SET status = 'dismissed' WHERE id = $1", [(req.params as { id: string }).id]);
    return { ok: true };
  });

  app.post("/admin/agents/:name", async (req, reply) => {
    const agent = AGENTS[(req.params as { name: string }).name];
    if (!agent) return reply.code(404).send({ error: "unknown agent" });
    const body = (req.body ?? {}) as { input?: unknown };
    const input = typeof body.input === "string" ? body.input : JSON.stringify(body.input ?? {});
    return runAgent(agent, input);
  });

  app.get("/admin/agent-runs", async () =>
    (
      await db.query(
        "SELECT id, agent, provider, input, output, tool_calls, error, duration_ms, created_at FROM agent_runs ORDER BY id DESC LIMIT 30",
      )
    ).rows);
}
