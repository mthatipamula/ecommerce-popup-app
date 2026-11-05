import type { Redis } from "ioredis";
import { db } from "../db/index.js";
import { newCode } from "./crypto.js";
import type { Campaign } from "./campaigns.js";
import type { ShopifyClient } from "../shopify/client.js";
import { config } from "../config.js";

/**
 * Hot path for issuing a code, in ONE Redis round trip (atomic Lua):
 *  1. per-IP velocity counter (hard block above the limit, no code spent)
 *  2. idempotency: the same email gets the same code back instead of a new one
 *  3. pop a pre-created code from the campaign's pool and remember who got it
 * Codes in the pool already exist in Shopify, so they are redeemable the moment they're shown.
 */
const ALLOCATE = `
local ip_count = redis.call('INCR', KEYS[3])
if ip_count == 1 then redis.call('EXPIRE', KEYS[3], 3600) end
if ip_count > tonumber(ARGV[1]) then return {'', -2, ip_count} end
local existing = redis.call('GET', KEYS[2])
if existing then return {existing, 0, ip_count} end
local code = redis.call('LPOP', KEYS[1])
if not code then return {'', -1, ip_count} end
redis.call('SET', KEYS[2], code, 'EX', 7776000)
redis.call('HINCRBY', KEYS[4], 'submits', 1)
return {code, 1, ip_count}
`;

export type Allocation =
  | { kind: "new" | "existing"; code: string; ipCount: number }
  | { kind: "empty"; ipCount: number }
  | { kind: "rate_limited"; ipCount: number };

export const IP_HOURLY_LIMIT = 30;

export const poolKey = (campaignId: string) => `pool:${campaignId}`;
export const statsKey = (campaignId: string) => `stats:${campaignId}`;

export function defineScripts(redis: Redis): void {
  redis.defineCommand("allocateCode", { numberOfKeys: 4, lua: ALLOCATE });
}

export async function allocateCode(redis: Redis, campaignId: string, emailHash: string, ipHash: string): Promise<Allocation> {
  const [code, status, ipCount] = (await (redis as any).allocateCode(
    poolKey(campaignId), `issued:${campaignId}:${emailHash}`, `vel:ip:${ipHash}`, statsKey(campaignId), IP_HOURLY_LIMIT,
  )) as [string, number, number];
  if (status === -2) return { kind: "rate_limited", ipCount };
  if (status === -1) return { kind: "empty", ipCount };
  return { kind: status === 1 ? "new" : "existing", code, ipCount };
}

/**
 * Create codes in Postgres and Shopify, then make them available in the Redis pool.
 * Order matters: a code only enters the pool after Shopify has accepted it.
 */
export async function mintCodes(redis: Redis, shopify: ShopifyClient, campaign: Campaign, count: number): Promise<string[]> {
  if (!campaign.shopifyDiscountId) throw new Error(`campaign ${campaign.id} has no Shopify discount`);
  const minted: string[] = [];
  for (let left = count; left > 0; left -= 100) {
    const candidates = Array.from({ length: Math.min(100, left) }, () => newCode(campaign.codePrefix));
    const inserted = await db.query(
      `INSERT INTO discount_codes (code, shop_domain, campaign_id)
       SELECT unnest($1::text[]), $2, $3 ON CONFLICT DO NOTHING RETURNING code`,
      [candidates, campaign.shopDomain, campaign.id],
    );
    const codes = inserted.rows.map((r) => r.code as string);
    if (codes.length === 0) continue;
    await shopify.addCodes(campaign.shopDomain, campaign.shopifyDiscountId, codes);
    await redis.rpush(poolKey(campaign.id), ...codes);
    minted.push(...codes);
  }
  return minted;
}

/**
 * Emergency top-up from the request path when the pool runs dry. Concurrent requests in one process share a
 * single mint instead of each minting their own batch (a thundering herd at 10k rps).
 */
const inflight = new Map<string, Promise<unknown>>();

export function mintNow(redis: Redis, shopify: ShopifyClient, campaign: Campaign, onStart?: () => void, count = 200): Promise<unknown> {
  let p = inflight.get(campaign.id);
  if (!p) {
    onStart?.();
    p = mintCodes(redis, shopify, campaign, count).finally(() => inflight.delete(campaign.id));
    inflight.set(campaign.id, p);
  }
  return p;
}

/**
 * Top up a campaign's pool; a short Redis lock keeps several workers from minting the same batch.
 * Size POOL_TARGET for peak traffic: at 10k sign-ups/s a 100k pool covers ten seconds of refill lag.
 */
export async function refillPool(redis: Redis, shopify: ShopifyClient, campaign: Campaign): Promise<number> {
  const size = await redis.llen(poolKey(campaign.id));
  if (size >= config.POOL_LOW_WATERMARK) return 0;
  const lock = await redis.set(`refill-lock:${campaign.id}`, "1", "EX", 30, "NX");
  if (!lock) return 0;
  try {
    return (await mintCodes(redis, shopify, campaign, config.POOL_TARGET - size)).length;
  } finally {
    await redis.del(`refill-lock:${campaign.id}`);
  }
}
