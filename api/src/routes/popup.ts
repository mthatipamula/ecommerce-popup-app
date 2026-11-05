import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { activeCampaignForShop } from "../lib/campaigns.js";
import { allocateCode, mintNow, statsKey } from "../lib/pool.js";
import { abuseScore, FLAG_THRESHOLD } from "../lib/abuse.js";
import { sha256 } from "../lib/crypto.js";
import { redis } from "../lib/redis.js";
import { shopify, DEMO_SHOP } from "../shopify/client.js";
import { config } from "../config.js";
import type { EventQueue } from "../queue/index.js";

const Shop = z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/, "must be a *.myshopify.com domain");

const Submit = z.object({
  shop: Shop,
  campaignId: z.string().uuid(),
  email: z.string().trim().toLowerCase().pipe(z.email()).refine((e) => e.length <= 254),
  phone: z.string().trim().max(32).optional().nullable(),
  smsConsent: z.boolean().default(false),
  visitorId: z.string().max(64).optional().nullable(),
});

const Event = z.object({ shop: Shop, campaignId: z.string().uuid(), kind: z.enum(["view", "close"]) });

/** Light E.164 normalisation: US 10-digit numbers get +1; anything else must already carry a country code. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  return "invalid";
}

export function applyUrl(shop: string, code: string): string {
  // On a real store, /discount/<code> applies the code to the cart and redirects home.
  return shop === DEMO_SHOP ? `${config.APP_URL}/demo/?discount=${encodeURIComponent(code)}` : `https://${shop}/discount/${encodeURIComponent(code)}`;
}

export async function popupRoutes(app: FastifyInstance, { queue }: { queue: EventQueue }) {
  // navigator.sendBeacon posts text/plain; treat it as JSON.
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error, undefined); }
  });

  app.get("/v1/popup/config", async (req, reply) => {
    const shop = Shop.safeParse((req.query as { shop?: string }).shop);
    if (!shop.success) return reply.code(400).send({ error: "shop is required" });
    const c = await activeCampaignForShop(shop.data);
    reply.header("Cache-Control", "public, max-age=30");
    if (!c) return { campaign: null };
    return {
      campaign: { id: c.id, headline: c.headline, body: c.body, cta: c.cta, discountPercent: c.discountPercent, theme: c.theme },
    };
  });

  app.post("/v1/popup/submit", async (req, reply) => {
    const parsed = Submit.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues.map((i) => i.message) });
    const input = parsed.data;
    const phone = normalizePhone(input.phone);
    if (phone === "invalid") return reply.code(400).send({ error: "Enter a valid mobile number" });

    const campaign = await activeCampaignForShop(input.shop);
    if (!campaign || campaign.id !== input.campaignId) return reply.code(410).send({ error: "This offer has ended" });

    const ipHash = sha256(req.ip).slice(0, 32);
    const emailHash = sha256(input.email).slice(0, 32);
    let alloc = await allocateCode(redis, campaign.id, emailHash, ipHash);
    if (alloc.kind === "empty") {
      // The worker keeps the pool topped up; this only happens on a cold start or a traffic spike.
      await mintNow(redis, shopify, campaign, () => req.log.warn({ campaign: campaign.id }, "code pool empty, minting synchronously"));
      alloc = await allocateCode(redis, campaign.id, emailHash, ipHash);
    }
    if (alloc.kind === "rate_limited") return reply.code(429).send({ error: "Too many sign-ups from this network. Try again later." });
    if (alloc.kind === "empty") return reply.code(503).send({ error: "Please try again in a moment" });
    const issued = alloc;

    if (issued.kind === "new") {
      const userAgent = req.headers["user-agent"] ?? null;
      const { score } = abuseScore({ email: input.email, ipCount: issued.ipCount, userAgent });
      await queue.publish({
        type: "signup", shop: input.shop, campaignId: campaign.id, email: input.email, phone,
        smsConsent: input.smsConsent && phone !== null, visitorId: input.visitorId ?? null, ipHash, userAgent,
        code: issued.code, abuseScore: score, at: new Date().toISOString(),
      });
      if (score >= FLAG_THRESHOLD) req.log.info({ campaign: campaign.id, score }, "sign-up flagged for abuse review");
    }
    return { code: issued.code, discountPercent: campaign.discountPercent, applyUrl: applyUrl(input.shop, issued.code), returning: issued.kind === "existing" };
  });

  app.post("/v1/popup/events", async (req, reply) => {
    const parsed = Event.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid event" });
    const e = parsed.data;
    await redis.hincrby(statsKey(e.campaignId), e.kind === "view" ? "views" : "closes", 1);
    await queue.publish({ type: e.kind, shop: e.shop, campaignId: e.campaignId, at: new Date().toISOString() });
    return reply.code(204).send();
  });
}
