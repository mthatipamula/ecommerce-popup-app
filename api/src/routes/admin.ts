import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { safeEqual } from "../lib/crypto.js";
import { listCampaigns, liveCampaignForShop } from "../lib/campaigns.js";
import { activate, applyRecommendation, createDraft, pause, remove } from "../lib/campaignService.js";
import { merchantContext, todayIn, validTimezone } from "../lib/schedule.js";
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
  // A schedule: e.g. one day, or 15 consecutive days. The dashboard sends local midnight-to-midnight as ISO times.
  startsAt: z.iso.datetime({ offset: true }).nullish(),
  endsAt: z.iso.datetime({ offset: true }).nullish(),
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
    // The dashboard is the demo shop's (in production: the shop from the App Bridge session token).
    campaigns: await listCampaigns(DEMO_SHOP),
    liveCampaignId: (await liveCampaignForShop(DEMO_SHOP))?.id ?? null,
    stats: await campaignStats(undefined, DEMO_SHOP),
    series: await dailySeries(14),
  }));

  app.get("/admin/signups", async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 50), 200);
    return (
      await db.query(
        `SELECT s.id, s.email, s.phone, s.sms_consent, s.code, s.abuse_score, s.abuse_status, s.created_at,
                d.status AS code_status, d.order_total_cents
         FROM signups s LEFT JOIN discount_codes d ON d.shop_domain = s.shop_domain AND d.code = s.code
         WHERE s.shop_domain = $2 ORDER BY s.id DESC LIMIT $1`,
        [limit, DEMO_SHOP],
      )
    ).rows;
  });

  app.post("/admin/campaigns", async (req, reply) => {
    const parsed = Draft.safeParse(req.body);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return reply.code(400).send({ error: `${i?.path.join(".") || "input"}: ${i?.message ?? "invalid"}` });
    }
    return createDraft(parsed.data);
  });
  app.post("/admin/campaigns/:id/activate", async (req) => activate(shopify, (req.params as { id: string }).id));
  app.post("/admin/campaigns/:id/pause", async (req) => {
    await pause((req.params as { id: string }).id);
    return { ok: true };
  });
  app.delete("/admin/campaigns/:id", async (req) => remove(shopify, (req.params as { id: string }).id));

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
    const body = (req.body ?? {}) as { input?: unknown; timezone?: unknown };
    const timezone = validTimezone(body.timezone) ? body.timezone : "UTC";
    let input = typeof body.input === "string" ? body.input : JSON.stringify(body.input ?? {});
    // Lets the model resolve "tomorrow" or "Nov 20"; schedules are whole days in the merchant's time zone.
    const today = todayIn(timezone);
    const weekday = new Date(`${today}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    input += `\n\n[Context: shop ${DEMO_SHOP}; merchant time zone ${timezone}; today is ${weekday} ${today}.]`;
    return merchantContext.run({ shop: DEMO_SHOP, timezone }, () => runAgent(agent, input));
  });

  app.get("/admin/agent-runs", async () =>
    (
      await db.query(
        "SELECT id, agent, provider, input, output, tool_calls, error, duration_ms, created_at FROM agent_runs ORDER BY id DESC LIMIT 30",
      )
    ).rows);
}
