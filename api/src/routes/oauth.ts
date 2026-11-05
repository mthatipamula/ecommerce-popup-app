import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { encrypt, verifyShopifyQueryHmac } from "../lib/crypto.js";
import { redis } from "../lib/redis.js";

const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Shopify OAuth (authorization code grant) for installing the app on a real store. */
export async function oauthRoutes(app: FastifyInstance) {
  app.get("/shopify/install", async (req, reply) => {
    const { shop } = req.query as { shop?: string };
    if (!shop || !SHOP.test(shop)) return reply.code(400).send({ error: "invalid shop" });
    const state = randomBytes(16).toString("hex");
    await redis.set(`oauth-state:${state}`, shop, "EX", 600);
    const url = new URL(`https://${shop}/admin/oauth/authorize`);
    url.searchParams.set("client_id", config.SHOPIFY_API_KEY);
    url.searchParams.set("scope", config.SHOPIFY_SCOPES);
    url.searchParams.set("redirect_uri", `${config.APP_URL}/shopify/callback`);
    url.searchParams.set("state", state);
    return reply.redirect(url.toString());
  });

  app.get("/shopify/callback", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (!verifyShopifyQueryHmac(q)) return reply.code(401).send({ error: "invalid hmac" });
    const expected = await redis.getdel(`oauth-state:${q.state}`);
    if (!expected || expected !== q.shop || !SHOP.test(q.shop)) return reply.code(401).send({ error: "invalid state" });

    const res = await fetch(`https://${q.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: config.SHOPIFY_API_KEY, client_secret: config.SHOPIFY_API_SECRET, code: q.code }),
    });
    if (!res.ok) return reply.code(502).send({ error: "token exchange failed" });
    const { access_token, scope } = (await res.json()) as { access_token: string; scope: string };
    await db.query(
      `INSERT INTO shops (shop_domain, access_token_enc, scopes) VALUES ($1, $2, $3)
       ON CONFLICT (shop_domain) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc, scopes = EXCLUDED.scopes,
         installed_at = now(), uninstalled_at = NULL`,
      [q.shop, encrypt(access_token), scope],
    );
    // Webhooks are declared in shopify.app.toml, so Shopify registers them on install.
    return reply.redirect(`https://${q.shop}/admin/apps/${config.SHOPIFY_API_KEY}`);
  });
}
