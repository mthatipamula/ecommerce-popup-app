import { db } from "../db/index.js";
import { shopify } from "../shopify/client.js";
import { activeCampaigns, campaignById, listCampaigns } from "../lib/campaigns.js";
import { createDraft } from "../lib/campaignService.js";
import { campaignStats, dailySeries } from "../lib/metrics.js";
import { runAgent, schema, type AgentDef } from "./runner.js";
import { DEMO_SHOP } from "../shopify/client.js";
import { describeWindow, merchantContext, parseSchedule, scheduleWindow, todayIn } from "../lib/schedule.js";

/** The merchant's time zone and shop for this request (set by the dashboard API); UTC and all shops otherwise. */
const tz = () => merchantContext.getStore()?.timezone ?? "UTC";
const ctxShop = () => merchantContext.getStore()?.shop;
/** The dashboard adds a context line with today's date for the model; offline parsing must not read dates from it. */
const CONTEXT_LINE = /\[Context:[^\]]*\]/gi;

/**
 * Four specialist agents and one orchestrator. None of them sits on the shopper's request path:
 * the popup API answers from Redis in a millisecond; agents work on drafts, recommendations and reviews
 * that a person approves (activating a campaign or applying an offer is always a human click).
 */

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// ------------------------------------------------------------------ 1. campaign agent

const hex = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };

export const campaignAgent: AgentDef = {
  name: "campaign-agent",
  effort: "medium",
  system: `You design email and SMS capture popups for Shopify brands.
Look at the store with get_store_profile and at past campaigns with get_campaign_history, then save exactly one draft with save_campaign_draft.
Rules for the copy:
- headline: at most 60 characters and it states the discount, e.g. "Take 15% off your first order".
- body: at most 140 characters, in the brand's voice, and mention what the shopper gets (the code, plus texts if they add a phone number).
- cta: at most 24 characters.
- discount_percent between 5 and 30 unless the merchant's brief asks for something else; when past campaigns show results, learn from them.
- Never promise anything the brief or store profile doesn't support (no "free shipping", no "sitewide" unless stated).
- theme colours must have readable contrast (dark text on light background or the reverse).
Schedule:
- If the brief names when it should run (a date, "tomorrow", "for 15 days", "from Dec 1 to Dec 15", a shopping day like Black Friday), set starts_on to the first day (YYYY-MM-DD) and days to how many consecutive days it runs. Resolve dates from "Today" in the request's context line, always picking the next occurrence.
- Otherwise set starts_on to "" and days to 0: an always-on campaign.
Reply with two or three sentences on the choices you made, including the schedule. The draft is not live until the merchant activates it.`,
  tools: [
    {
      name: "get_store_profile",
      description: "Store name, currency and best-selling products with prices and types.",
      input_schema: schema({ shop: { type: "string", description: "The *.myshopify.com domain" } }),
      run: ({ shop }) => shopify.shopProfile(shop),
    },
    {
      name: "get_campaign_history",
      description: "Past and current popup campaigns for the shop, with views, sign-ups, redemptions and revenue.",
      input_schema: schema({ shop: { type: "string" } }),
      run: async ({ shop }) => {
        const ids = new Set((await listCampaigns(shop)).map((c) => c.id));
        return (await campaignStats()).filter((s) => ids.has(s.campaignId));
      },
    },
    {
      name: "save_campaign_draft",
      description: "Save the popup as a draft campaign. Returns the new campaign id.",
      input_schema: schema({
        shop: { type: "string" },
        name: { type: "string", description: "Internal campaign name" },
        headline: { type: "string" },
        body: { type: "string" },
        cta: { type: "string" },
        discount_percent: { type: "integer", minimum: 1, maximum: 90 },
        code_prefix: { type: "string", description: "Short uppercase prefix for the codes, e.g. RUN15" },
        theme: {
          type: "object",
          properties: { primary: hex, background: hex, text: hex },
          required: ["primary", "background", "text"],
          additionalProperties: false,
        },
        starts_on: { type: "string", description: "First day YYYY-MM-DD in the merchant's time zone, or \"\" for always on" },
        days: { type: "integer", minimum: 0, maximum: 366, description: "Consecutive days it runs (1 = that day only), or 0 for always on" },
      }),
      run: async (i) => {
        const scheduled = /^\d{4}-\d{2}-\d{2}$/.test(i.starts_on ?? "") && i.days > 0;
        const window = scheduled ? scheduleWindow(i.starts_on, Math.min(i.days, 366), tz()) : null;
        const c = await createDraft({
          shopDomain: i.shop, name: i.name, headline: i.headline.slice(0, 60), body: i.body.slice(0, 140), cta: i.cta.slice(0, 24),
          discountPercent: Math.min(Math.max(i.discount_percent, 1), 90), codePrefix: i.code_prefix, theme: i.theme, createdBy: "campaign-agent",
          ...(window ?? {}),
        });
        return { campaignId: c.id, status: c.status, schedule: describeWindow(c.startsAt, c.endsAt, tz()) };
      },
    },
  ],
  async offline(input, call) {
    const { shop, brief: raw } = JSON.parse(input) as { shop: string; brief: string };
    const brief = raw.replace(CONTEXT_LINE, " ");
    const profile = await call("get_store_profile", { shop });
    await call("get_campaign_history", { shop });
    const asked = /(\d{1,2})\s*%/.exec(brief);
    const percent = asked ? Number(asked[1]) : 15;
    const when = parseSchedule(brief, todayIn(tz()));
    const label = when?.label ?? "Welcome";
    const types = [...new Set(profile.products.map((p: any) => p.productType))].slice(0, 2).join(" and ").toLowerCase();
    const headline = !when ? `Take ${percent}% off your first order`
      : when.label ? `${when.label}: ${percent}% off`
      : when.days === 1 ? `Today only: ${percent}% off` : `${percent}% off for ${when.days} days only`;
    const draft = await call("save_campaign_draft", {
      shop, name: `${label} ${percent}%`,
      headline,
      body: `Join ${profile.name} for early access to new ${types} drops. Add your number for text-only deals.`,
      cta: `Unlock my ${percent}% off`, discount_percent: percent,
      code_prefix: `${label.replace(/[^A-Za-z]/g, "").slice(0, 8).toUpperCase()}${percent}`,
      theme: { primary: "#0f766e", background: "#ffffff", text: "#0b1220" },
      starts_on: when?.startDate ?? "", days: when?.days ?? 0,
    });
    return `Drafted "${label} ${percent}%" for ${profile.name}, ${draft.schedule === "always on" ? "always on" : `scheduled ${draft.schedule}`}. `
      + `Click ${when ? "Schedule" : "Activate"} next to it in Campaigns to put it live.`;
  },
};

// ------------------------------------------------------------------ 2. offer agent

const MIN_VIEWS = 200;
const MIN_SIGNUPS = 30;

export const offerAgent: AgentDef = {
  name: "offer-agent",
  effort: "medium",
  system: `You tune the discount on a popup campaign to balance list growth against margin.
Read the campaign with get_campaign_stats and its siblings with get_offer_history, then decide.
- Below ${MIN_VIEWS} views or ${MIN_SIGNUPS} sign-ups the data is too thin: say so and do not propose a change.
- Sign-up rate under 3% suggests the offer is too weak; above 8% with a low redemption rate suggests it can be smaller.
- Move in steps of 5 points, never below 5% or above 30%.
- If you recommend a change, call propose_offer once. A person applies it; it starts a new campaign version so results stay comparable.
Explain your reasoning with the actual numbers in three or four sentences.`,
  tools: [
    {
      name: "get_campaign_stats",
      description: "Views, sign-ups, SMS opt-ins, redemptions, revenue and rates for one campaign.",
      input_schema: schema({ campaign_id: { type: "string" } }),
      run: async ({ campaign_id }) => (await campaignStats(campaign_id))[0] ?? { error: "no such campaign" },
    },
    {
      name: "get_offer_history",
      description: "All campaigns for the same shop with their discount and results, to compare offers.",
      input_schema: schema({ campaign_id: { type: "string" } }),
      run: async ({ campaign_id }) => {
        const c = await campaignById(campaign_id);
        if (!c) return [];
        const ids = new Set((await listCampaigns(c.shopDomain)).map((x) => x.id));
        return (await campaignStats()).filter((s) => ids.has(s.campaignId));
      },
    },
    {
      name: "propose_offer",
      description: "Record a discount recommendation for a person to apply or dismiss.",
      input_schema: schema({
        campaign_id: { type: "string" },
        discount_percent: { type: "integer", minimum: 5, maximum: 30 },
        rationale: { type: "string" },
      }),
      run: async ({ campaign_id, discount_percent, rationale }) => {
        const p = Math.min(Math.max(Math.round(discount_percent / 5) * 5, 5), 30);
        const r = await db.query(
          "INSERT INTO offer_recommendations (campaign_id, discount_percent, rationale) VALUES ($1, $2, $3) RETURNING id",
          [campaign_id, p, rationale],
        );
        return { recommendationId: r.rows[0].id, discountPercent: p };
      },
    },
  ],
  async offline(input, call) {
    const { campaignId } = JSON.parse(input) as { campaignId: string };
    const s = await call("get_campaign_stats", { campaign_id: campaignId });
    if (s.error) return s.error;
    await call("get_offer_history", { campaign_id: campaignId });
    if (s.views < MIN_VIEWS && s.signups < MIN_SIGNUPS) {
      return `Not enough data yet: ${s.views} views and ${s.signups} sign-ups (need ${MIN_VIEWS} views or ${MIN_SIGNUPS} sign-ups). Keeping ${s.discountPercent}%.`;
    }
    let next = s.discountPercent;
    let why = "";
    if (s.signupRate < 0.03) { next += 5; why = `sign-up rate is ${pct(s.signupRate)}, under the 3% floor`; }
    else if (s.signupRate > 0.08 && s.redemptionRate < 0.2) { next -= 5; why = `sign-ups are strong at ${pct(s.signupRate)} but only ${pct(s.redemptionRate)} redeem`; }
    next = Math.min(Math.max(next, 5), 30);
    if (next === s.discountPercent) {
      return `Keep ${s.discountPercent}%: sign-up rate ${pct(s.signupRate)} and redemption rate ${pct(s.redemptionRate)} are in the healthy range.`;
    }
    const rationale = `${why}; testing ${next}% (from ${s.discountPercent}%).`;
    await call("propose_offer", { campaign_id: campaignId, discount_percent: next, rationale });
    return `Proposed ${next}% because ${rationale}`;
  },
};

// ------------------------------------------------------------------ 3. abuse agent

export const abuseAgent: AgentDef = {
  name: "abuse-agent",
  effort: "low",
  system: `You review popup sign-ups that cheap rules flagged as possible discount abuse (bots, code farming, disposable emails).
List them with list_flagged_signups, look at each with get_signup_context, and record a verdict for every one with record_verdict.
Block only when at least two independent signals agree (for example a disposable domain AND many sign-ups from the same network).
When in doubt, allow: blocking a real customer costs more than one extra discount. Blocking revokes the code before it can be used.
Finish with a one-paragraph summary: how many you reviewed, allowed and blocked, and the main pattern you saw.`,
  tools: [
    {
      name: "list_flagged_signups",
      description: "Sign-ups awaiting review, oldest first. Emails are partly masked.",
      input_schema: schema({ limit: { type: "integer", minimum: 1, maximum: 50 } }),
      run: async ({ limit }) => (await db.query(
        `SELECT id, campaign_id, regexp_replace(email, '^(.).*(@.*)$', '\\1***\\2') AS email, abuse_score, created_at
         FROM signups WHERE abuse_status = 'flagged' ORDER BY id LIMIT $1`, [Math.min(limit, 50)])).rows,
    },
    {
      name: "get_signup_context",
      description: "Signals for one sign-up: email domain, how many sign-ups share its network, visitor and domain, user agent, whether the code was used.",
      input_schema: schema({ signup_id: { type: "integer" } }),
      run: async ({ signup_id }) => {
        const s = (await db.query("SELECT * FROM signups WHERE id = $1", [signup_id])).rows[0];
        if (!s) return { error: "not found" };
        const domain = s.email.split("@")[1];
        const q = (sql: string, args: unknown[]) => db.query(sql, args).then((r) => Number(r.rows[0].n));
        const [sameIp, sameVisitor, sameDomain, code] = await Promise.all([
          q("SELECT count(*) n FROM signups WHERE ip_hash = $1 AND created_at > $2::timestamptz - interval '1 day'", [s.ip_hash, s.created_at]),
          s.visitor_id ? q("SELECT count(*) n FROM signups WHERE visitor_id = $1", [s.visitor_id]) : Promise.resolve(1),
          q("SELECT count(*) n FROM signups WHERE campaign_id = $1 AND email LIKE $2", [s.campaign_id, `%@${domain}`]),
          db.query("SELECT status FROM discount_codes WHERE shop_domain = $1 AND code = $2", [s.shop_domain, s.code]).then((r) => r.rows[0]?.status),
        ]);
        return {
          signupId: s.id, emailDomain: domain, ruleScore: s.abuse_score, userAgent: s.user_agent, signupsSameNetwork24h: sameIp,
          signupsSameVisitor: sameVisitor, signupsSameDomainThisCampaign: sameDomain, hasPhone: !!s.phone, codeStatus: code,
        };
      },
    },
    {
      name: "record_verdict",
      description: "Allow or block a flagged sign-up. Blocking revokes its discount code in Shopify unless it was already redeemed.",
      input_schema: schema({
        signup_id: { type: "integer" },
        verdict: { type: "string", enum: ["allow", "block"] },
        reason: { type: "string" },
      }),
      run: async ({ signup_id, verdict, reason }) => {
        const s = (await db.query(
          "UPDATE signups SET abuse_status = $2 WHERE id = $1 AND abuse_status = 'flagged' RETURNING shop_domain, campaign_id, code",
          [signup_id, verdict === "block" ? "blocked" : "allowed"],
        )).rows[0];
        if (!s) return { error: "not flagged or not found" };
        let revoked = false;
        if (verdict === "block") {
          const c = await campaignById(s.campaign_id);
          const r = await db.query(
            "UPDATE discount_codes SET status = 'revoked' WHERE shop_domain = $1 AND code = $2 AND status <> 'redeemed' RETURNING code",
            [s.shop_domain, s.code],
          );
          if (r.rowCount && c?.shopifyDiscountId) { await shopify.disableCode(s.shop_domain, c.shopifyDiscountId, s.code); revoked = true; }
        }
        return { signupId: signup_id, verdict, revoked, reason };
      },
    },
  ],
  async offline(_input, call) {
    const flagged = await call("list_flagged_signups", { limit: 50 });
    let blocked = 0;
    for (const f of flagged) {
      const ctx = await call("get_signup_context", { signup_id: f.id });
      const signals = [
        ctx.ruleScore >= 50,
        ctx.signupsSameNetwork24h >= 10,
        ctx.signupsSameVisitor >= 3,
        !ctx.userAgent || /curl|python|bot|headless/i.test(ctx.userAgent),
      ].filter(Boolean).length;
      const block = signals >= 2;
      if (block) blocked++;
      await call("record_verdict", {
        signup_id: f.id, verdict: block ? "block" : "allow",
        reason: block ? `${signals} independent abuse signals` : "single weak signal; treating as a real shopper",
      });
    }
    return `Reviewed ${flagged.length} flagged sign-ups: blocked ${blocked}, allowed ${flagged.length - blocked}.`;
  },
};

// ------------------------------------------------------------------ 4. insights agent

export const insightsAgent: AgentDef = {
  name: "insights-agent",
  effort: "low",
  system: `You answer a merchant's questions about their popup campaigns: views, sign-ups, SMS opt-ins, code redemptions and revenue.
Use get_campaign_stats and get_daily_series; quote the actual numbers and never estimate figures the tools didn't return.
Answer in at most five sentences, then one concrete suggestion if the data supports one.`,
  tools: [
    {
      name: "get_campaign_stats",
      description: "Funnel numbers for every campaign (empty campaign_id) or one campaign.",
      input_schema: schema({ campaign_id: { type: "string", description: "Campaign id, or empty for all" } }),
      run: ({ campaign_id }) => campaignStats(campaign_id || undefined),
    },
    {
      name: "get_daily_series",
      description: "Sign-ups, SMS opt-ins, redemptions and revenue per day.",
      input_schema: schema({ days: { type: "integer", minimum: 1, maximum: 90 }, campaign_id: { type: "string", description: "Campaign id, or empty for all" } }),
      run: ({ days, campaign_id }) => dailySeries(days, campaign_id || undefined),
    },
  ],
  async offline(_input, call) {
    const stats = await call("get_campaign_stats", { campaign_id: "" });
    await call("get_daily_series", { days: 7, campaign_id: "" });
    if (!stats.length) return "There are no campaigns yet.";
    const t = stats.reduce((a: any, s: any) => ({
      views: a.views + s.views, signups: a.signups + s.signups, sms: a.sms + s.smsOptIns,
      redemptions: a.redemptions + s.redemptions, revenue: a.revenue + s.revenueCents,
    }), { views: 0, signups: 0, sms: 0, redemptions: 0, revenue: 0 });
    const best = [...stats].sort((a: any, b: any) => b.redemptions - a.redemptions)[0];
    return `Across ${stats.length} campaign(s): ${t.views} views, ${t.signups} sign-ups (${pct(t.views ? t.signups / t.views : 0)}), ` +
      `${t.sms} SMS opt-ins, ${t.redemptions} codes redeemed for ${usd(t.revenue)} in orders. Best performer: "${best.name}" with ${best.redemptions} redemptions.`;
  },
};

// ------------------------------------------------------------------ orchestrator

const SPECIALISTS = { campaign: campaignAgent, offer: offerAgent, abuse: abuseAgent, insights: insightsAgent };

export const orchestrator: AgentDef = {
  name: "orchestrator",
  effort: "medium",
  system: `You are the merchant's assistant for their Shopify popup. You don't do the work yourself; you hand it to specialist agents:
- run_campaign_agent: design a new popup draft from a brief, including when it runs (a date, N consecutive days, or always on). Pass the merchant's words about dates and the context line through in the brief.
- run_offer_agent: review a live campaign's discount and maybe propose a change.
- run_abuse_agent: review flagged sign-ups for bots and code farming.
- run_insights_agent: answer questions about performance.
Use list_campaigns to find campaign ids. Call as many specialists as the request needs (in parallel when they're independent), then give the merchant a short combined answer.
Nothing you do goes live on its own: drafts need activating and offers need applying in the dashboard. Say so when it applies.`,
  tools: [
    {
      name: "list_campaigns",
      description: "All campaigns with id, shop, name, status and discount.",
      input_schema: schema({}),
      run: async () => (await listCampaigns(ctxShop())).map((c) => ({
        id: c.id, shop: c.shopDomain, name: c.name, status: c.status, discountPercent: c.discountPercent,
        schedule: describeWindow(c.startsAt, c.endsAt, tz()),
      })),
    },
    {
      name: "run_campaign_agent",
      description: "Have the campaign agent draft a new popup for a shop.",
      input_schema: schema({ shop: { type: "string" }, brief: { type: "string" } }),
      run: async ({ shop, brief }) => summary(await runAgent(campaignAgent, JSON.stringify({ shop, brief }))),
    },
    {
      name: "run_offer_agent",
      description: "Have the offer agent review one campaign's discount.",
      input_schema: schema({ campaign_id: { type: "string" } }),
      run: async ({ campaign_id }) => summary(await runAgent(offerAgent, JSON.stringify({ campaignId: campaign_id }))),
    },
    {
      name: "run_abuse_agent",
      description: "Have the abuse agent review all flagged sign-ups.",
      input_schema: schema({}),
      run: async () => summary(await runAgent(abuseAgent, "Review all flagged sign-ups.")),
    },
    {
      name: "run_insights_agent",
      description: "Ask the insights agent a question about performance.",
      input_schema: schema({ question: { type: "string" } }),
      run: async ({ question }) => summary(await runAgent(insightsAgent, question)),
    },
  ],
  async offline(input, call) {
    const q = input.replace(CONTEXT_LINE, " ").toLowerCase();
    const campaigns = await call("list_campaigns", {});
    const live = campaigns.find((c: any) => c.status === "active");
    const parts: string[] = [];
    if (/fraud|abuse|bot|spam|farm/.test(q)) parts.push((await call("run_abuse_agent", {})).output);
    if (/discount|offer|optimi|percent|margin/.test(q) && live) parts.push((await call("run_offer_agent", { campaign_id: live.id })).output);
    if (/create|new popup|design|launch|draft|campaign for|schedule|welcome|\d+\s*% off|popup (on|for|from)/.test(q)) {
      parts.push((await call("run_campaign_agent", { shop: live?.shop ?? ctxShop() ?? DEMO_SHOP, brief: input })).output);
    }
    if (!parts.length || /how|perform|report|stats|result/.test(q)) parts.push((await call("run_insights_agent", { question: input })).output);
    return parts.join("\n\n");
  },
};

const summary = (r: { agent: string; output: string; runId: number }) => ({ agent: r.agent, runId: r.runId, output: r.output });

export const AGENTS: Record<string, AgentDef> = { ...SPECIALISTS, orchestrator };

/** Called by the worker on a schedule: review flags without waiting for a person to ask. */
export async function scheduledAbuseReview(): Promise<void> {
  const n = Number((await db.query("SELECT count(*) n FROM signups WHERE abuse_status = 'flagged'")).rows[0].n);
  if (n > 0) await runAgent(abuseAgent, "Review all flagged sign-ups.");
}

export { activeCampaigns };
