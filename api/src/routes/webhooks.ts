import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { redis } from "../lib/redis.js";
import { safeEqual, shopifyWebhookHmac } from "../lib/crypto.js";
import { invalidateShop } from "../lib/campaigns.js";
import type { EventQueue } from "../queue/index.js";

interface ShopifyOrder {
  id: number | string;
  total_price?: string;
  discount_codes?: { code: string; amount: string; type: string }[];
}

/**
 * Shopify webhooks. Shopify expects a 200 within a few seconds and retries otherwise, so handlers verify,
 * dedupe and enqueue; the worker does the database work.
 */
export async function webhookRoutes(app: FastifyInstance, { queue }: { queue: EventQueue }) {
  // HMAC is computed over the exact bytes Shopify sent: keep the raw body in this plugin scope.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.addHook("preHandler", async (req, reply) => {
    const hmac = req.headers["x-shopify-hmac-sha256"];
    if (typeof hmac !== "string" || !safeEqual(shopifyWebhookHmac(req.body as Buffer), hmac)) {
      return reply.code(401).send({ error: "invalid webhook signature" });
    }
    const id = req.headers["x-shopify-webhook-id"];
    if (typeof id === "string" && !(await redis.set(`whk:${id}`, "1", "EX", 86400, "NX"))) {
      return reply.code(200).send({ duplicate: true });
    }
  });

  const shopOf = (h: Record<string, unknown>) => String(h["x-shopify-shop-domain"] ?? "");
  const json = <T>(b: unknown) => JSON.parse((b as Buffer).toString("utf8")) as T;

  app.post("/webhooks/orders/create", async (req) => {
    const order = json<ShopifyOrder>(req.body);
    const codes = (order.discount_codes ?? []).map((d) => d.code.toUpperCase());
    if (codes.length) {
      await queue.publish({
        type: "order", shop: shopOf(req.headers), webhookId: String(req.headers["x-shopify-webhook-id"] ?? `order-${order.id}`),
        orderId: String(order.id), codes, totalCents: Math.round(Number(order.total_price ?? 0) * 100), at: new Date().toISOString(),
      });
    }
    return { ok: true };
  });

  app.post("/webhooks/app/uninstalled", async (req) => {
    const shop = shopOf(req.headers);
    await db.query("UPDATE shops SET uninstalled_at = now(), access_token_enc = NULL WHERE shop_domain = $1", [shop]);
    await db.query("UPDATE campaigns SET status = 'paused' WHERE shop_domain = $1 AND status = 'active'", [shop]);
    await invalidateShop(shop);
    return { ok: true };
  });

  // Mandatory privacy webhooks for apps in the Shopify App Store.
  app.post("/webhooks/customers/data_request", async (req) => {
    req.log.info({ shop: shopOf(req.headers) }, "customer data request received; export handled by support");
    return { ok: true };
  });
  app.post("/webhooks/customers/redact", async (req) => {
    const body = json<{ customer?: { email?: string } }>(req.body);
    if (body.customer?.email) {
      await db.query("DELETE FROM signups WHERE shop_domain = $1 AND email = $2", [shopOf(req.headers), body.customer.email.toLowerCase()]);
    }
    return { ok: true };
  });
  app.post("/webhooks/shop/redact", async (req) => {
    await db.query("DELETE FROM signups WHERE shop_domain = $1", [shopOf(req.headers)]);
    return { ok: true };
  });
}
