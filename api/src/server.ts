import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { redis } from "./lib/redis.js";
import { defineScripts } from "./lib/pool.js";
import { popupRoutes } from "./routes/popup.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { mockShopifyRoutes } from "./routes/mockShopify.js";
import { oauthRoutes } from "./routes/oauth.js";
import { adminRoutes } from "./routes/admin.js";
import type { EventQueue } from "./queue/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer(queue: EventQueue): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: true, // Cloud Run / load balancer sets X-Forwarded-For; req.ip is the shopper's address
    bodyLimit: 64 * 1024,
  });
  defineScripts(redis);

  // The popup runs on every merchant's storefront domain; the public endpoints accept any origin.
  await app.register(cors, { origin: true, methods: ["GET", "POST"] });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await Promise.all([db.query("SELECT 1"), redis.ping()]);
      return { ok: true };
    } catch (e) {
      return reply.code(503).send({ ok: false, error: String(e) });
    }
  });

  await app.register(popupRoutes, { queue });
  await app.register(webhookRoutes, { queue });
  await app.register(oauthRoutes);
  await app.register(adminRoutes);
  if (config.SHOPIFY_MODE === "mock") await app.register(mockShopifyRoutes);

  // Built web assets (popup bundle, demo storefront, dashboard). In GCP the popup bundle is served from GCS + CDN.
  const web = [path.join(here, "../../web/dist"), path.join(here, "../web")].find((p) => existsSync(p));
  if (config.SERVE_WEB && web) {
    await app.register(fastifyStatic, { root: web, prefix: "/", index: ["index.html"] });
    app.get("/", (_req, reply) => reply.redirect("/demo/"));
  }
  return app;
}
