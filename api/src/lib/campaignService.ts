import { db } from "../db/index.js";
import { redis } from "./redis.js";
import { campaignById, invalidateShop, type Campaign } from "./campaigns.js";
import { mintCodes } from "./pool.js";
import { newCode } from "./crypto.js";
import type { ShopifyClient } from "../shopify/client.js";

export interface CampaignDraft {
  shopDomain: string;
  name: string;
  headline: string;
  body: string;
  cta: string;
  discountPercent: number;
  codePrefix?: string;
  theme?: Record<string, string>;
  createdBy?: string;
}

export async function ensureShop(shop: string): Promise<void> {
  await db.query("INSERT INTO shops (shop_domain) VALUES ($1) ON CONFLICT DO NOTHING", [shop]);
}

export async function createDraft(d: CampaignDraft): Promise<Campaign> {
  await ensureShop(d.shopDomain);
  const prefix = (d.codePrefix ?? "WELCOME").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "WELCOME";
  const r = await db.query(
    `INSERT INTO campaigns (shop_domain, name, discount_percent, code_prefix, headline, body, cta, theme, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [d.shopDomain, d.name, d.discountPercent, prefix, d.headline, d.body, d.cta, JSON.stringify(d.theme ?? {}), d.createdBy ?? "human"],
  );
  return (await campaignById(r.rows[0].id))!;
}

/** Go live: create the Shopify discount if needed, swap out the shop's previous campaign, pre-fill the code pool. */
export async function activate(shopify: ShopifyClient, id: string): Promise<Campaign> {
  let c = await campaignById(id);
  if (!c) throw new Error("campaign not found");
  if (!c.shopifyDiscountId) {
    const discountId = await shopify.createDiscount(c.shopDomain, {
      title: `${c.name} (${c.discountPercent}% off, Popup)`, percent: c.discountPercent, firstCode: newCode(c.codePrefix),
    });
    await db.query("UPDATE campaigns SET shopify_discount_id = $2 WHERE id = $1", [id, discountId]);
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE campaigns SET status = 'paused' WHERE shop_domain = $1 AND status = 'active' AND id <> $2", [c.shopDomain, id]);
    await client.query("UPDATE campaigns SET status = 'active' WHERE id = $1", [id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  c = (await campaignById(id))!;
  if ((await redis.llen(`pool:${id}`)) === 0) await mintCodes(redis, shopify, c, 200);
  await invalidateShop(c.shopDomain);
  return c;
}

export async function pause(id: string): Promise<void> {
  const c = await campaignById(id);
  if (!c) throw new Error("campaign not found");
  await db.query("UPDATE campaigns SET status = 'paused' WHERE id = $1", [id]);
  await invalidateShop(c.shopDomain);
}

/** A new discount percentage means a new Shopify discount, so an accepted offer becomes a new campaign version. */
export async function applyRecommendation(shopify: ShopifyClient, recId: number): Promise<Campaign> {
  const rec = (await db.query("SELECT * FROM offer_recommendations WHERE id = $1 AND status = 'proposed'", [recId])).rows[0];
  if (!rec) throw new Error("recommendation not found or already handled");
  const base = (await campaignById(rec.campaign_id))!;
  const next = await createDraft({
    shopDomain: base.shopDomain, name: `${base.name.replace(/ \(\d+% test\)$/, "")} (${rec.discount_percent}% test)`,
    headline: base.headline.replace(/\d+%/, `${rec.discount_percent}%`), body: base.body, cta: base.cta,
    discountPercent: rec.discount_percent, codePrefix: base.codePrefix, theme: base.theme, createdBy: "offer-agent",
  });
  await db.query("UPDATE offer_recommendations SET status = 'applied' WHERE id = $1", [recId]);
  return activate(shopify, next.id);
}
