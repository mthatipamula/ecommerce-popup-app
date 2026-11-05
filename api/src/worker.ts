import type { Redis } from "ioredis";
import { db } from "./db/index.js";
import { FLAG_THRESHOLD } from "./lib/abuse.js";
import { activeCampaigns } from "./lib/campaigns.js";
import { refillPool, statsKey } from "./lib/pool.js";
import { shopify } from "./shopify/client.js";
import { scheduledAbuseReview } from "./agents/agents.js";
import type { EventQueue, PopupEvent } from "./queue/index.js";

type Signup = Extract<PopupEvent, { type: "signup" }>;
type Count = Extract<PopupEvent, { type: "view" | "close" }>;
type Order = Extract<PopupEvent, { type: "order" }>;

const SIGNUP_COLS = [
  ["shop_domain", "text"], ["campaign_id", "uuid"], ["email", "text"], ["phone", "text"], ["sms_consent", "bool"],
  ["visitor_id", "text"], ["ip_hash", "text"], ["user_agent", "text"], ["code", "text"], ["abuse_score", "int"],
  ["abuse_status", "text"], ["created_at", "timestamptz"],
] as const;

/**
 * Background side of the system, step 1: drain the event queue into Postgres in batches.
 * One multi-row statement per batch and event type (unnest() keeps the parameter count fixed however big the batch).
 * Every write is idempotent, because both queues deliver at least once.
 */
export async function writeBatch(batch: PopupEvent[], redis: Redis): Promise<void> {
  const signups = batch.filter((e): e is Signup => e.type === "signup");
  const counts = batch.filter((e): e is Count => e.type === "view" || e.type === "close");
  const orders = batch.filter((e): e is Order => e.type === "order");

  if (signups.length) {
    const rows = signups.map((s) => [
      s.shop, s.campaignId, s.email, s.phone, s.smsConsent, s.visitorId, s.ipHash, s.userAgent, s.code,
      s.abuseScore, s.abuseScore >= FLAG_THRESHOLD ? "flagged" : "ok", s.at,
    ]);
    const casts = SIGNUP_COLS.map(([, type], i) => "$" + (i + 1) + "::" + type + "[]").join(", ");
    await db.query(
      `INSERT INTO signups (${SIGNUP_COLS.map(([c]) => c).join(", ")})
       SELECT * FROM unnest(${casts})
       ON CONFLICT (campaign_id, email) DO NOTHING`,
      SIGNUP_COLS.map((_, i) => rows.map((r) => r[i])),
    );
    await db.query(
      `UPDATE discount_codes d SET status = 'issued', issued_at = x.at
       FROM unnest($1::text[], $2::text[], $3::timestamptz[]) AS x(shop, code, at)
       WHERE d.shop_domain = x.shop AND d.code = x.code AND d.status = 'available'`,
      [signups.map((s) => s.shop), signups.map((s) => s.code), signups.map((s) => s.at)],
    );
  }

  if (counts.length) {
    const agg = new Map<string, number>();
    for (const e of counts) {
      const hour = new Date(e.at);
      hour.setUTCMinutes(0, 0, 0);
      const k = [e.campaignId, hour.toISOString(), e.type].join("|");
      agg.set(k, (agg.get(k) ?? 0) + 1);
    }
    const rows = [...agg].map(([k, n]) => [...k.split("|"), n]);
    await db.query(
      `INSERT INTO popup_events (campaign_id, hour, kind, count)
       SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::text[], $4::bigint[])
       ON CONFLICT (campaign_id, hour, kind) DO UPDATE SET count = popup_events.count + EXCLUDED.count`,
      [0, 1, 2, 3].map((i) => rows.map((r) => r[i])),
    );
  }

  for (const o of orders) {
    const fresh = await db.query(
      "INSERT INTO webhook_deliveries (webhook_id, topic, shop_domain) VALUES ($1, 'orders/create', $2) ON CONFLICT DO NOTHING RETURNING 1",
      [o.webhookId, o.shop],
    );
    if (!fresh.rowCount) continue; // redelivered: already counted
    const r = await db.query(
      `UPDATE discount_codes SET status = 'redeemed', redeemed_at = $4, order_id = $3, order_total_cents = $5
       WHERE shop_domain = $1 AND code = ANY($2::text[]) AND status IN ('available', 'issued')
       RETURNING campaign_id`,
      [o.shop, o.codes, o.orderId, o.at, o.totalCents],
    );
    for (const row of r.rows) await redis.hincrby(statsKey(row.campaign_id), "redemptions", 1);
  }
}

/** Step 2 and 3: keep live code pools topped up, and let the abuse agent review flags on a schedule. */
export async function startWorker(queue: EventQueue, redis: Redis, log: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  const stopQueue = await queue.consume((batch) => writeBatch(batch, redis));

  const refill = async () => {
    for (const c of await activeCampaigns()) {
      const n = await refillPool(redis, shopify, c).catch((e) => {
        log.error(e, "refill failed");
        return 0;
      });
      if (n) log.info({ campaign: c.id, minted: n }, "code pool refilled");
    }
  };
  const abuse = () => scheduledAbuseReview().catch((e) => log.error(e, "abuse review failed"));

  await refill();
  const timers = [setInterval(refill, 1_000), setInterval(abuse, 60_000)];
  log.info("worker started");
  return async () => {
    timers.forEach(clearInterval);
    await stopQueue();
  };
}
