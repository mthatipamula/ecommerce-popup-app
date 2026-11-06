import { db } from "../db/index.js";
import { redis } from "./redis.js";

export interface Campaign {
  id: string;
  shopDomain: string;
  name: string;
  /** active = always on; scheduled = runs only between startsAt and endsAt, taking over from the active one. */
  status: "draft" | "active" | "scheduled" | "paused";
  discountPercent: number;
  codePrefix: string;
  shopifyDiscountId: string | null;
  headline: string;
  body: string;
  cta: string;
  theme: Record<string, string>;
  createdBy: string;
  createdAt: string;
  startsAt: string | null;
  endsAt: string | null;
}

const COLS = `id, shop_domain AS "shopDomain", name, status, discount_percent AS "discountPercent",
  code_prefix AS "codePrefix", shopify_discount_id AS "shopifyDiscountId", headline, body, cta, theme,
  created_by AS "createdBy", created_at AS "createdAt", starts_at AS "startsAt", ends_at AS "endsAt"`;

export async function campaignById(id: string): Promise<Campaign | null> {
  const r = await db.query(`SELECT ${COLS} FROM campaigns WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function listCampaigns(shop?: string): Promise<Campaign[]> {
  const r = shop
    ? await db.query(`SELECT ${COLS} FROM campaigns WHERE shop_domain = $1 ORDER BY created_at DESC`, [shop])
    : await db.query(`SELECT ${COLS} FROM campaigns ORDER BY created_at DESC`);
  return r.rows;
}

/**
 * Campaigns whose code pools the worker keeps filled: the always-on ones, plus scheduled ones that are running
 * or start within the hour, so their pool is already full when the first shopper sees the popup.
 */
export async function activeCampaigns(): Promise<Campaign[]> {
  return (
    await db.query(
      `SELECT ${COLS} FROM campaigns
       WHERE status = 'active' OR (status = 'scheduled' AND ends_at > now() AND starts_at <= now() + interval '1 hour')`,
    )
  ).rows;
}

/** The campaign a shopper sees right now: a scheduled one inside its window wins over the always-on one. */
const LIVE = `SELECT ${COLS} FROM campaigns
  WHERE shop_domain = $1
    AND (status = 'active' OR (status = 'scheduled' AND starts_at <= now() AND ends_at > now()))
  ORDER BY (status = 'scheduled') DESC, starts_at DESC
  LIMIT 1`;

/** Seconds until the next scheduled start or end for the shop, so caches never serve a campaign past its window. */
const NEXT_BOUNDARY = `SELECT extract(epoch FROM min(t) - now()) AS s FROM (
    SELECT starts_at AS t FROM campaigns WHERE shop_domain = $1 AND status = 'scheduled' AND starts_at > now()
    UNION ALL
    SELECT ends_at FROM campaigns WHERE shop_domain = $1 AND status = 'scheduled' AND ends_at > now()
  ) x`;

export async function liveCampaignForShop(shop: string): Promise<Campaign | null> {
  return (await db.query(LIVE, [shop])).rows[0] ?? null;
}

/**
 * Three cache tiers for the hottest read: in-process (10 s), Redis (60 s), Postgres.
 * At 10k rps nearly every request is answered from process memory without any network hop.
 */
const local = new Map<string, { until: number; value: Campaign | null }>();
const LOCAL_TTL_MS = 10_000;
const REDIS_TTL_S = 60;

export async function activeCampaignForShop(shop: string): Promise<Campaign | null> {
  const hit = local.get(shop);
  if (hit && Date.now() < hit.until) return hit.value;
  const key = `cfg:${shop}`;
  const [cached, pttl] = await Promise.all([redis.get(key), redis.pttl(key)]);
  let value: Campaign | null;
  let ttlMs: number;
  if (cached !== null) {
    value = JSON.parse(cached);
    ttlMs = pttl > 0 ? pttl : LOCAL_TTL_MS;
  } else {
    const [live, next] = await Promise.all([db.query(LIVE, [shop]), db.query(NEXT_BOUNDARY, [shop])]);
    value = live.rows[0] ?? null;
    // Expire exactly when a scheduled campaign starts or ends, never later.
    const boundary = next.rows[0]?.s == null ? Infinity : Number(next.rows[0].s) * 1000;
    ttlMs = Math.max(1000, Math.min(REDIS_TTL_S * 1000, Math.ceil(boundary)));
    await redis.set(key, JSON.stringify(value), "PX", ttlMs);
  }
  local.set(shop, { until: Date.now() + Math.min(LOCAL_TTL_MS, ttlMs), value });
  return value;
}

export async function invalidateShop(shop: string): Promise<void> {
  local.delete(shop);
  await redis.del(`cfg:${shop}`);
}
