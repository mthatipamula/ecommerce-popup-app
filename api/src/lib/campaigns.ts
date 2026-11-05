import { db } from "../db/index.js";
import { redis } from "./redis.js";

export interface Campaign {
  id: string;
  shopDomain: string;
  name: string;
  status: "draft" | "active" | "paused";
  discountPercent: number;
  codePrefix: string;
  shopifyDiscountId: string | null;
  headline: string;
  body: string;
  cta: string;
  theme: Record<string, string>;
  createdBy: string;
  createdAt: string;
}

const COLS = `id, shop_domain AS "shopDomain", name, status, discount_percent AS "discountPercent",
  code_prefix AS "codePrefix", shopify_discount_id AS "shopifyDiscountId", headline, body, cta, theme,
  created_by AS "createdBy", created_at AS "createdAt"`;

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

export async function activeCampaigns(): Promise<Campaign[]> {
  return (await db.query(`SELECT ${COLS} FROM campaigns WHERE status = 'active'`)).rows;
}

/**
 * Three cache tiers for the hottest read: in-process (10 s), Redis (60 s), Postgres.
 * At 10k rps nearly every request is answered from process memory without any network hop.
 */
const local = new Map<string, { at: number; value: Campaign | null }>();
const LOCAL_TTL_MS = 10_000;

export async function activeCampaignForShop(shop: string): Promise<Campaign | null> {
  const hit = local.get(shop);
  if (hit && Date.now() - hit.at < LOCAL_TTL_MS) return hit.value;
  const key = `cfg:${shop}`;
  const cached = await redis.get(key);
  let value: Campaign | null;
  if (cached !== null) {
    value = JSON.parse(cached);
  } else {
    const r = await db.query(`SELECT ${COLS} FROM campaigns WHERE shop_domain = $1 AND status = 'active'`, [shop]);
    value = r.rows[0] ?? null;
    await redis.set(key, JSON.stringify(value), "EX", 60);
  }
  local.set(shop, { at: Date.now(), value });
  return value;
}

export async function invalidateShop(shop: string): Promise<void> {
  local.delete(shop);
  await redis.del(`cfg:${shop}`);
}
