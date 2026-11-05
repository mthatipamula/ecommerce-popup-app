import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { shopify, DEMO_SHOP } from "../shopify/client.js";
import { shopifyWebhookHmac } from "../lib/crypto.js";
import { randomUUID } from "node:crypto";

/**
 * The simulated Shopify store (SHOPIFY_MODE=mock): a catalogue, a checkout that validates discount codes the way
 * Shopify would, and an orders/create webhook signed with the app secret and delivered to our real webhook
 * endpoint, so redemption runs through exactly the code path a real store would trigger.
 */
const Checkout = z.object({
  shop: z.string().default(DEMO_SHOP),
  email: z.string().email().optional(),
  items: z.array(z.object({ title: z.string(), qty: z.number().int().min(1).max(20) })).min(1),
  discountCode: z.string().trim().toUpperCase().optional(),
});

export async function mockShopifyRoutes(app: FastifyInstance) {
  app.get("/mock-shopify/products", async () => (await shopify.shopProfile(DEMO_SHOP)).products);

  app.post("/mock-shopify/checkout", async (req, reply) => {
    const input = Checkout.parse(req.body);
    const catalogue = (await shopify.shopProfile(input.shop)).products;
    let subtotal = 0;
    for (const item of input.items) {
      const p = catalogue.find((c) => c.title === item.title);
      if (!p) return reply.code(400).send({ error: `unknown product ${item.title}` });
      subtotal += p.priceCents * item.qty;
    }

    let discount = 0;
    if (input.discountCode) {
      const r = await db.query(
        `SELECT c.usage_count, c.disabled, d.discount_percent FROM mock_shopify_codes c
         JOIN mock_shopify_discounts d ON d.id = c.discount_id WHERE c.shop_domain = $1 AND c.code = $2`,
        [input.shop, input.discountCode],
      );
      const code = r.rows[0];
      if (!code) return reply.code(422).send({ error: "Enter a valid discount code" });
      if (code.disabled) return reply.code(422).send({ error: "This discount code is no longer valid" });
      if (code.usage_count > 0) return reply.code(422).send({ error: "This discount code has already been used" });
      discount = Math.round((subtotal * code.discount_percent) / 100);
    }

    const total = subtotal - discount;
    const order = (await db.query(
      `INSERT INTO mock_shopify_orders (shop_domain, email, subtotal_cents, discount_cents, total_cents, discount_code)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.shop, input.email ?? null, subtotal, discount, total, input.discountCode ?? null],
    )).rows[0];
    if (input.discountCode) {
      await db.query("UPDATE mock_shopify_codes SET usage_count = usage_count + 1 WHERE shop_domain = $1 AND code = $2", [input.shop, input.discountCode]);
    }

    // Shopify-shaped orders/create payload (only the fields the app reads, plus a few for realism).
    const payload = {
      id: 5_000_000_000 + Number(order.id),
      email: input.email ?? null,
      currency: "USD",
      subtotal_price: (subtotal / 100).toFixed(2),
      total_discounts: (discount / 100).toFixed(2),
      total_price: (total / 100).toFixed(2),
      discount_codes: input.discountCode ? [{ code: input.discountCode, amount: (discount / 100).toFixed(2), type: "percentage" }] : [],
      line_items: input.items.map((i) => ({ title: i.title, quantity: i.qty })),
      created_at: new Date().toISOString(),
    };
    setImmediate(() => deliverWebhook(input.shop, "orders/create", payload).catch((e) => app.log.error(e, "webhook delivery failed")));

    return { orderId: payload.id, subtotalCents: subtotal, discountCents: discount, totalCents: total, discountCode: input.discountCode ?? null };
  });
}

export async function deliverWebhook(shop: string, topic: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const res = await fetch(`http://127.0.0.1:${config.PORT}/webhooks/${topic}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-Webhook-Id": randomUUID(),
      "X-Shopify-API-Version": config.SHOPIFY_API_VERSION,
      "X-Shopify-Hmac-Sha256": shopifyWebhookHmac(body),
    },
    body,
  });
  if (!res.ok) throw new Error(`webhook ${topic} -> ${res.status}`);
}
