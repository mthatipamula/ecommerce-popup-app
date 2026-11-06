import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db, migrate } from "../src/db/index.js";
import { redis, createRedis } from "../src/lib/redis.js";
import { allocateCode, defineScripts, IP_HOURLY_LIMIT, poolKey } from "../src/lib/pool.js";
import { activate, createDraft, pause } from "../src/lib/campaignService.js";
import { activeCampaignForShop, liveCampaignForShop } from "../src/lib/campaigns.js";
import { config } from "../src/config.js";
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

describe("scheduled campaigns", () => {
  const sShop = `sched-${Date.now()}.myshopify.com`;
  const mock = new MockShopifyClient();
  const hour = 3_600_000;
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  const draft = (name: string, startsAt?: string, endsAt?: string) =>
    createDraft({ shopDomain: sShop, name, headline: "h", body: "b", cta: "c", discountPercent: 20, codePrefix: "S", startsAt, endsAt });

  it("takes over from the always-on campaign only inside its window", async () => {
    const always = await activate(mock, (await draft("always")).id);
    const now = await activate(mock, (await draft("today", at(-hour), at(hour))).id);
    expect(always.status).toBe("active");
    expect(now.status).toBe("scheduled");
    expect((await activeCampaignForShop(sShop))?.id).toBe(now.id);
    // A future window doesn't change what shows today.
    const later = await activate(mock, (await draft("later", at(48 * hour), at(72 * hour))).id);
    expect((await liveCampaignForShop(sShop))?.id).toBe(now.id);
    // Pausing the running one brings the always-on campaign back straight away.
    await pause(now.id);
    expect((await activeCampaignForShop(sShop))?.id).toBe(always.id);
    expect(later.status).toBe("scheduled");
  });

  it("refuses overlapping schedules and bad windows", async () => {
    const a = await activate(mock, (await draft("a", at(10 * hour), at(30 * hour))).id);
    await expect(activate(mock, (await draft("b", at(20 * hour), at(40 * hour))).id)).rejects.toThrow(/overlaps "a"/);
    await expect(draft("backwards", at(2 * hour), at(hour))).rejects.toThrow(/end after it starts/);
    await expect(draft("half", at(hour))).rejects.toThrow(/both a start and an end/);
    await pause(a.id);
  });

  it("only accepts a scheduled campaign's codes during its dates", async () => {
    const future = await activate(mock, (await draft("future", at(100 * hour), at(124 * hour))).id);
    const code = (await db.query("SELECT code FROM discount_codes WHERE campaign_id = $1 LIMIT 1", [future.id])).rows[0].code;
    const r = await app.inject({ method: "GET", url: `/mock-shopify/discount/${code}?shop=${sShop}` });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/isn't active yet/);
    await pause(future.id);
  });

  it("lets the dashboard create a scheduled campaign", async () => {
    const auth = { authorization: `Bearer ${config.ADMIN_TOKEN}` };
    const bad = await app.inject({ method: "POST", url: "/admin/campaigns", headers: auth,
      payload: { shopDomain: sShop, name: "x", headline: "h", body: "b", cta: "c", discountPercent: 20, startsAt: "tomorrow" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/admin/campaigns", headers: auth,
      payload: { shopDomain: sShop, name: "Welcome 20%", headline: "h", body: "b", cta: "c", discountPercent: 20, startsAt: at(200 * hour), endsAt: at(200 * hour + 15 * 24 * hour) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "draft", name: "Welcome 20%" });
    expect(ok.json().startsAt).toBeTruthy();
  });
});

describe("store customer accounts (simulated Shopify)", () => {
  const email = `cust-${randomUUID()}@example.com`;

  it("registers, signs in, reads the account and signs out", async () => {
    const reg = await app.inject({ method: "POST", url: "/mock-shopify/account/register", payload: { email, password: "correct-horse", firstName: "Jo" } });
    expect(reg.statusCode).toBe(200);
    expect(reg.json().customer).toEqual({ email, firstName: "Jo" });
    const dup = await app.inject({ method: "POST", url: "/mock-shopify/account/register", payload: { email, password: "correct-horse", firstName: "Jo" } });
    expect(dup.statusCode).toBe(409);

    const wrong = await app.inject({ method: "POST", url: "/mock-shopify/account/login", payload: { email, password: "nope-nope" } });
    expect(wrong.statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/mock-shopify/account/login", payload: { email: email.toUpperCase(), password: "correct-horse" } });
    expect(login.statusCode).toBe(200);
    const headers = { authorization: `Bearer ${login.json().token}` };

    const me = await app.inject({ method: "GET", url: "/mock-shopify/account/me", headers });
    expect(me.json()).toMatchObject({ customer: { email, firstName: "Jo" }, orders: [] });
    await app.inject({ method: "POST", url: "/mock-shopify/account/logout", headers });
    expect((await app.inject({ method: "GET", url: "/mock-shopify/account/me", headers })).statusCode).toBe(401);
  });
});
