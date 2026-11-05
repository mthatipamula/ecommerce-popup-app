import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db, migrate } from "../src/db/index.js";
import { redis, createRedis } from "../src/lib/redis.js";
import { allocateCode, defineScripts, IP_HOURLY_LIMIT, poolKey } from "../src/lib/pool.js";
import { activate, createDraft } from "../src/lib/campaignService.js";
import { MockShopifyClient } from "../src/shopify/client.js";
import { shopifyWebhookHmac } from "../src/lib/crypto.js";
import { createQueue } from "../src/queue/index.js";
import { buildServer } from "../src/server.js";
import { writeBatch } from "../src/worker.js";
import type { Campaign } from "../src/lib/campaigns.js";

/** Runs against real Postgres and Redis (docker compose locally, service containers in CI). */
const shop = `test-${Date.now()}.myshopify.com`;
let campaign: Campaign;
let app: FastifyInstance;
const consumer = createRedis();

beforeAll(async () => {
  await migrate();
  defineScripts(redis);
  const draft = await createDraft({ shopDomain: shop, name: "t", headline: "10% off", body: "b", cta: "c", discountPercent: 10, codePrefix: "T" });
  campaign = await activate(new MockShopifyClient(), draft.id);
  app = await buildServer(createQueue(redis, consumer));
});

afterAll(async () => {
  await app.close();
  await Promise.allSettled([redis.quit(), consumer.quit(), db.end()]);
});

describe("code allocation (Redis Lua)", () => {
  it("gives the same email the same code, and different emails different codes", async () => {
    const a = await allocateCode(redis, campaign.id, "email-a", `ip-${randomUUID()}`);
    const again = await allocateCode(redis, campaign.id, "email-a", `ip-${randomUUID()}`);
    const b = await allocateCode(redis, campaign.id, "email-b", `ip-${randomUUID()}`);
    expect(a.kind).toBe("new");
    expect(again).toMatchObject({ kind: "existing", code: (a as { code: string }).code });
    expect((b as { code: string }).code).not.toBe((a as { code: string }).code);
  });

  it("never hands out one code twice under concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 150 }, (_, i) => allocateCode(redis, campaign.id, `c-${i}`, `ip-c-${i}`)));
    const codes = results.map((r) => (r as { code: string }).code);
    expect(new Set(codes).size).toBe(150);
  });

  it("rate-limits one network without spending codes", async () => {
    const ip = `ip-${randomUUID()}`;
    const before = await redis.llen(poolKey(campaign.id));
    for (let i = 0; i < IP_HOURLY_LIMIT; i++) await allocateCode(redis, campaign.id, `rl-${ip}-${i}`, ip);
    const blocked = await allocateCode(redis, campaign.id, `rl-${ip}-x`, ip);
    expect(blocked.kind).toBe("rate_limited");
    expect(await redis.llen(poolKey(campaign.id))).toBe(before - IP_HOURLY_LIMIT);
  });

  it("reports an empty pool", async () => {
    const id = randomUUID();
    expect((await allocateCode(redis, id, "e", "i")).kind).toBe("empty");
  });
});

describe("write-behind batches", () => {
  it("inserts sign-ups idempotently and marks the codes issued", async () => {
    const alloc = (await allocateCode(redis, campaign.id, "wb", `ip-${randomUUID()}`)) as { code: string };
    const event = {
      type: "signup" as const, shop, campaignId: campaign.id, email: `wb-${randomUUID()}@example.com`, phone: "+12145550100",
      smsConsent: true, visitorId: "v", ipHash: "h", userAgent: "Mozilla", code: alloc.code, abuseScore: 0, at: new Date().toISOString(),
    };
    await writeBatch([event, event], redis); // duplicate delivery in one batch
    await writeBatch([event], redis);        // and redelivered later
    const n = await db.query("SELECT count(*)::int n FROM signups WHERE email = $1", [event.email]);
    expect(n.rows[0].n).toBe(1);
    const code = await db.query("SELECT status FROM discount_codes WHERE shop_domain = $1 AND code = $2", [shop, alloc.code]);
    expect(code.rows[0].status).toBe("issued");
  });

  it("redeems a code once per webhook delivery", async () => {
    const alloc = (await allocateCode(redis, campaign.id, "order", `ip-${randomUUID()}`)) as { code: string };
    const order = { type: "order" as const, shop, webhookId: randomUUID(), orderId: "42", codes: [alloc.code], totalCents: 9000, at: new Date().toISOString() };
    await writeBatch([order], redis);
    await writeBatch([order], redis);
    const r = await db.query("SELECT status, order_total_cents FROM discount_codes WHERE shop_domain = $1 AND code = $2", [shop, alloc.code]);
    expect(r.rows[0]).toMatchObject({ status: "redeemed", order_total_cents: "9000" });
  });
});

describe("HTTP", () => {
  it("issues a code through the public endpoint and rejects a bad email", async () => {
    const ok = await app.inject({
      method: "POST", url: "/v1/popup/submit", headers: { "user-agent": "Mozilla/5.0" },
      payload: { shop, campaignId: campaign.id, email: `http-${randomUUID()}@example.com`, phone: "214-555-0100", smsConsent: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().code).toMatch(/^T-/);
    const bad = await app.inject({ method: "POST", url: "/v1/popup/submit", payload: { shop, campaignId: campaign.id, email: "nope" } });
    expect(bad.statusCode).toBe(400);
  });

  it("only accepts webhooks signed with the app secret", async () => {
    const body = JSON.stringify({ id: 1, total_price: "10.00", discount_codes: [] });
    const headers = { "content-type": "application/json", "x-shopify-shop-domain": shop, "x-shopify-webhook-id": randomUUID() };
    const bad = await app.inject({ method: "POST", url: "/webhooks/orders/create", headers: { ...headers, "x-shopify-hmac-sha256": "x" }, payload: body });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: "POST", url: "/webhooks/orders/create", headers: { ...headers, "x-shopify-hmac-sha256": shopifyWebhookHmac(body) }, payload: body });
    expect(good.statusCode).toBe(200);
  });

  it("keeps the dashboard API behind the admin token", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/overview" })).statusCode).toBe(401);
  });
});
