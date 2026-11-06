import { db } from "../db/index.js";
import { redis } from "./redis.js";
import { poolKey, statsKey } from "./pool.js";

export interface CampaignStats {
  campaignId: string;
  name: string;
  status: string;
  discountPercent: number;
  views: number;
  signups: number;
  smsOptIns: number;
  redemptions: number;
  revenueCents: number;
  flagged: number;
  blocked: number;
  poolSize: number;
  signupRate: number;      // signups / views
  redemptionRate: number;  // redemptions / signups
}

/** Live counters (views, pool) come from Redis; everything that must be exact comes from Postgres. */
export async function campaignStats(campaignId?: string, shop?: string): Promise<CampaignStats[]> {
  const where = campaignId ? "WHERE c.id = $1" : shop ? "WHERE c.shop_domain = $1" : "";
  const args = campaignId ? [campaignId] : shop ? [shop] : [];
  const r = await db.query(
    `SELECT c.id, c.name, c.status, c.discount_percent,
       (SELECT count(*) FROM signups s WHERE s.campaign_id = c.id)::int AS signups,
       (SELECT count(*) FROM signups s WHERE s.campaign_id = c.id AND s.sms_consent)::int AS sms,
       (SELECT count(*) FROM signups s WHERE s.campaign_id = c.id AND s.abuse_status = 'flagged')::int AS flagged,
       (SELECT count(*) FROM signups s WHERE s.campaign_id = c.id AND s.abuse_status = 'blocked')::int AS blocked,
       (SELECT count(*) FROM discount_codes d WHERE d.campaign_id = c.id AND d.status = 'redeemed')::int AS redemptions,
       (SELECT coalesce(sum(order_total_cents), 0) FROM discount_codes d WHERE d.campaign_id = c.id AND d.status = 'redeemed')::bigint AS revenue
     FROM campaigns c ${where} ORDER BY c.created_at DESC`,
    args,
  );
  return Promise.all(r.rows.map(async (row) => {
    const [views, poolSize] = await Promise.all([redis.hget(statsKey(row.id), "views"), redis.llen(poolKey(row.id))]);
    const v = Number(views ?? 0);
    return {
      campaignId: row.id, name: row.name, status: row.status, discountPercent: row.discount_percent,
      views: v, signups: row.signups, smsOptIns: row.sms, redemptions: row.redemptions, revenueCents: Number(row.revenue),
      flagged: row.flagged, blocked: row.blocked, poolSize,
      signupRate: v ? +(row.signups / v).toFixed(4) : 0,
      redemptionRate: row.signups ? +(row.redemptions / row.signups).toFixed(4) : 0,
    };
  }));
}

/** Daily series for the insights agent: sign-ups and redemptions per day. */
export async function dailySeries(days: number, campaignId?: string) {
  const args: unknown[] = [Math.min(Math.max(days, 1), 90)];
  const filter = campaignId ? (args.push(campaignId), "AND campaign_id = $2") : "";
  const signups = await db.query(
    `SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS signups,
       count(*) FILTER (WHERE sms_consent)::int AS sms_opt_ins
     FROM signups WHERE created_at > now() - make_interval(days => $1) ${filter} GROUP BY 1 ORDER BY 1`, args);
  const redemptions = await db.query(
    `SELECT date_trunc('day', redeemed_at)::date AS day, count(*)::int AS redemptions, coalesce(sum(order_total_cents),0)::bigint AS revenue_cents
     FROM discount_codes WHERE status = 'redeemed' AND redeemed_at > now() - make_interval(days => $1) ${filter} GROUP BY 1 ORDER BY 1`, args);
  return { signups: signups.rows, redemptions: redemptions.rows.map((r) => ({ ...r, revenue_cents: Number(r.revenue_cents) })) };
}
