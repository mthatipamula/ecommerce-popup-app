import { db } from "../db/index.js";
import { redis } from "./redis.js";
import { campaignById, invalidateShop, type Campaign } from "./campaigns.js";
import { mintCodes, poolKey } from "./pool.js";
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
  /** Both set: a scheduled campaign that runs only in [startsAt, endsAt). Both unset: always on once activated. */
  startsAt?: string | null;
  endsAt?: string | null;
}

/** An error the admin API reports to the merchant as-is (Fastify uses statusCode for the response). */
export class CampaignError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}

export function checkWindow(startsAt?: string | null, endsAt?: string | null): void {
  if (!startsAt && !endsAt) return;
  if (!startsAt || !endsAt) throw new CampaignError("A schedule needs both a start and an end", 400);
  const start = Date.parse(startsAt), end = Date.parse(endsAt);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new CampaignError("Invalid schedule dates", 400);
  if (end <= start) throw new CampaignError("The schedule must end after it starts", 400);
  if (end - start > 366 * 86_400_000) throw new CampaignError("A schedule can run for at most a year", 400);
}

export async function ensureShop(shop: string): Promise<void> {
  await db.query("INSERT INTO shops (shop_domain) VALUES ($1) ON CONFLICT DO NOTHING", [shop]);
}

export async function createDraft(d: CampaignDraft): Promise<Campaign> {
  checkWindow(d.startsAt, d.endsAt);
  await ensureShop(d.shopDomain);
  const prefix = (d.codePrefix ?? "WELCOME").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "WELCOME";
  const r = await db.query(
    `INSERT INTO campaigns (shop_domain, name, discount_percent, code_prefix, headline, body, cta, theme, created_by, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [d.shopDomain, d.name, d.discountPercent, prefix, d.headline, d.body, d.cta, JSON.stringify(d.theme ?? {}), d.createdBy ?? "human",
      d.startsAt ?? null, d.endsAt ?? null],
  );
  return (await campaignById(r.rows[0].id))!;
}

/**
 * Go live. An always-on campaign replaces the shop's previous always-on one. A campaign with a schedule becomes
 * "scheduled": it takes over only inside its window (no two windows may overlap), and its Shopify discount is
 * limited to the same window. Then create the Shopify discount if needed and pre-fill the code pool.
 */
export async function activate(shopify: ShopifyClient, id: string): Promise<Campaign> {
  let c = await campaignById(id);
  if (!c || c.status === "archived") throw new CampaignError("campaign not found", 404);
  const scheduled = Boolean(c.startsAt && c.endsAt);
  if (scheduled) {
    if (new Date(c.endsAt!).getTime() <= Date.now()) throw new CampaignError("This campaign's schedule has already ended");
    const clash = await db.query(
      `SELECT name FROM campaigns WHERE shop_domain = $1 AND status = 'scheduled' AND id <> $2 AND starts_at < $4 AND ends_at > $3 LIMIT 1`,
      [c.shopDomain, id, c.startsAt, c.endsAt],
    );
    if (clash.rowCount) throw new CampaignError(`The schedule overlaps "${clash.rows[0].name}". Pause that campaign or pick other dates.`);
  }
  if (!c.shopifyDiscountId) {
    const discountId = await shopify.createDiscount(c.shopDomain, {
      title: `${c.name} (${c.discountPercent}% off, Popup)`, percent: c.discountPercent, firstCode: newCode(c.codePrefix),
      startsAt: c.startsAt, endsAt: c.endsAt,
    });
    await db.query("UPDATE campaigns SET shopify_discount_id = $2 WHERE id = $1", [id, discountId]);
  }
  if (scheduled) {
    await db.query("UPDATE campaigns SET status = 'scheduled' WHERE id = $1", [id]);
  } else {
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
  }
  c = (await campaignById(id))!;
  if ((await redis.llen(`pool:${id}`)) === 0) await mintCodes(redis, shopify, c, 200);
  await invalidateShop(c.shopDomain);
  return c;
}

export async function pause(id: string): Promise<void> {
  const c = await campaignById(id);
  if (!c) throw new CampaignError("campaign not found", 404);
  await db.query("UPDATE campaigns SET status = 'paused' WHERE id = $1", [id]);
  await invalidateShop(c.shopDomain);
}

/**
 * Remove a campaign from the dashboard. It stops showing first. If no shopper ever got one of its codes, it is
 * deleted outright and its Shopify discount switched off. Otherwise it is archived: hidden from the list but kept
 * for reporting, and codes already sent to shoppers keep working; its unissued pool codes are thrown away.
 */
export async function remove(shopify: ShopifyClient, id: string): Promise<{ removed: "deleted" | "archived" }> {
  const c = await campaignById(id);
  if (!c) throw new CampaignError("campaign not found", 404);
  const used = await db.query(
    `SELECT EXISTS (SELECT 1 FROM signups WHERE campaign_id = $1)
         OR EXISTS (SELECT 1 FROM discount_codes WHERE campaign_id = $1 AND status <> 'available') AS used`,
    [id],
  );
  await redis.del(poolKey(id));
  if (used.rows[0].used) {
    await db.query("UPDATE campaigns SET status = 'archived' WHERE id = $1", [id]);
    await db.query("DELETE FROM discount_codes WHERE campaign_id = $1 AND status = 'available'", [id]);
    await invalidateShop(c.shopDomain);
    return { removed: "archived" };
  }
  if (c.shopifyDiscountId) await shopify.deactivateDiscount(c.shopDomain, c.shopifyDiscountId);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM offer_recommendations WHERE campaign_id = $1", [id]);
    await client.query("DELETE FROM discount_codes WHERE campaign_id = $1", [id]);
    await client.query("DELETE FROM campaigns WHERE id = $1", [id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  await invalidateShop(c.shopDomain);
  return { removed: "deleted" };
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
    startsAt: base.startsAt, endsAt: base.endsAt,
  });
  // A scheduled campaign's new version takes over the same window, so the old version steps aside first.
  if (base.status === "scheduled") await pause(base.id);
  await db.query("UPDATE offer_recommendations SET status = 'applied' WHERE id = $1", [recId]);
  return activate(shopify, next.id);
}
