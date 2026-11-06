import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { shopify, DEMO_SHOP } from "../shopify/client.js";
import { hashPassword, sha256, shopifyWebhookHmac, verifyPassword } from "../lib/crypto.js";
import { randomBytes, randomUUID } from "node:crypto";

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

/** Validates a code the way Shopify's checkout does; shared by the cart preview and the checkout itself. */
async function lookupCode(shop: string, code: string): Promise<{ percent: number } | { error: string }> {
  const r = await db.query(
    `SELECT c.usage_count, c.disabled, d.discount_percent,
            d.starts_at > now() AS not_started, d.ends_at <= now() AS ended
     FROM mock_shopify_codes c
     JOIN mock_shopify_discounts d ON d.id = c.discount_id WHERE c.shop_domain = $1 AND c.code = $2`,
    [shop, code],
  );
  const row = r.rows[0];
  if (!row) return { error: "Enter a valid discount code" };
  if (row.disabled) return { error: "This discount code is no longer valid" };
  if (row.usage_count > 0) return { error: "This discount code has already been used" };
  if (row.not_started) return { error: "This discount code isn't active yet" };
  if (row.ended) return { error: "This discount code has expired" };
  return { percent: Number(row.discount_percent) };
}

const Register = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(8, "Use at least 8 characters").max(200),
  firstName: z.string().trim().min(1, "Enter your first name").max(60),
});
const Login = z.object({ email: z.string().trim().toLowerCase(), password: z.string().max(200) });
const SESSION_DAYS = 30;

interface Customer { id: number; email: string; firstName: string }

/** Bearer token → signed-in customer. Only a hash of the token is stored. */
async function customerFromRequest(authorization: string | undefined): Promise<Customer | null> {
  const token = (authorization ?? "").replace(/^Bearer /, "");
  if (!token) return null;
  const r = await db.query(
    `SELECT c.id, c.email, c.first_name AS "firstName" FROM mock_shopify_sessions s
     JOIN mock_shopify_customers c ON c.id = s.customer_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return r.rows[0] ?? null;
}

async function startSession(customer: Customer) {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO mock_shopify_sessions (token_hash, customer_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    [sha256(token), customer.id, SESSION_DAYS],
  );
  return { token, customer: { email: customer.email, firstName: customer.firstName } };
}

export async function mockShopifyRoutes(app: FastifyInstance) {
  app.get("/mock-shopify/products", async () => (await shopify.shopProfile(DEMO_SHOP)).products);

  // ---- Customer accounts. On a real store Shopify handles sign-in; the theme passes {{ customer }} to the popup.
  app.post("/mock-shopify/account/register", async (req, reply) => {
    const parsed = Register.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Check your details" });
    const { email, password, firstName } = parsed.data;
    const r = await db.query(
      `INSERT INTO mock_shopify_customers (shop_domain, email, first_name, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (shop_domain, email) DO NOTHING RETURNING id, email, first_name AS "firstName"`,
      [DEMO_SHOP, email, firstName, hashPassword(password)],
    );
    if (!r.rowCount) return reply.code(409).send({ error: "An account with this email already exists. Sign in instead." });
    return startSession(r.rows[0]);
  });

  app.post("/mock-shopify/account/login", async (req, reply) => {
    const parsed = Login.safeParse(req.body);
    const fail = () => reply.code(401).send({ error: "Incorrect email or password" });
    if (!parsed.success) return fail();
    const r = await db.query(
      `SELECT id, email, first_name AS "firstName", password_hash FROM mock_shopify_customers WHERE shop_domain = $1 AND email = $2`,
      [DEMO_SHOP, parsed.data.email],
    );
    const row = r.rows[0];
    if (!row || !verifyPassword(parsed.data.password, row.password_hash)) return fail();
    return startSession(row);
  });

  app.get("/mock-shopify/account/me", async (req, reply) => {
    const c = await customerFromRequest(req.headers.authorization);
    if (!c) return reply.code(401).send({ error: "Not signed in" });
    const orders = await db.query(
      `SELECT id, total_cents AS "totalCents", discount_code AS "discountCode", created_at AS "createdAt"
       FROM mock_shopify_orders WHERE shop_domain = $1 AND email = $2 ORDER BY id DESC LIMIT 10`,
      [DEMO_SHOP, c.email],
    );
    return { customer: { email: c.email, firstName: c.firstName }, orders: orders.rows.map((o) => ({ ...o, id: 5_000_000_000 + Number(o.id) })) };
  });

  app.post("/mock-shopify/account/logout", async (req) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (token) await db.query("DELETE FROM mock_shopify_sessions WHERE token_hash = $1", [sha256(token)]);
    return { ok: true };
  });

  // Lets the cart show the discounted total before payment, as Shopify does once a code is applied.
  app.get("/mock-shopify/discount/:code", async (req, reply) => {
    const { code } = req.params as { code: string };
    const { shop } = req.query as { shop?: string };
    const result = await lookupCode(shop ?? DEMO_SHOP, code.trim().toUpperCase());
    if ("error" in result) return reply.code(422).send(result);
    return { code: code.trim().toUpperCase(), percent: result.percent };
  });

  app.post("/mock-shopify/checkout", async (req, reply) => {
    const input = Checkout.parse(req.body);
    // A signed-in customer's order is attached to their account, like Shopify's customer on the order.
    const customer = await customerFromRequest(req.headers.authorization);
    const email = input.email?.toLowerCase() ?? customer?.email ?? null;
    const catalogue = (await shopify.shopProfile(input.shop)).products;
    let subtotal = 0;
    for (const item of input.items) {
      const p = catalogue.find((c) => c.title === item.title);
      if (!p) return reply.code(400).send({ error: `unknown product ${item.title}` });
      subtotal += p.priceCents * item.qty;
    }

    let discount = 0;
    if (input.discountCode) {
      const code = await lookupCode(input.shop, input.discountCode);
      if ("error" in code) return reply.code(422).send({ error: code.error });
      discount = Math.round((subtotal * code.percent) / 100);
    }

    const total = subtotal - discount;
    const order = (await db.query(
      `INSERT INTO mock_shopify_orders (shop_domain, email, subtotal_cents, discount_cents, total_cents, discount_code)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.shop, email, subtotal, discount, total, input.discountCode ?? null],
    )).rows[0];
    if (input.discountCode) {
      await db.query("UPDATE mock_shopify_codes SET usage_count = usage_count + 1 WHERE shop_domain = $1 AND code = $2", [input.shop, input.discountCode]);
    }

    // Shopify-shaped orders/create payload (only the fields the app reads, plus a few for realism).
    const payload = {
      id: 5_000_000_000 + Number(order.id),
      email: email,
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
