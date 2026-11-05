import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const Env = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8080),
  /** api = request path only, worker = queue consumer + schedulers, all = both (local demo). */
  ROLE: z.enum(["api", "worker", "all"]).default("all"),
  DATABASE_URL: z.string().default("postgres://popup:popup@localhost:5432/popup"),
  DB_POOL_MAX: z.coerce.number().default(10),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  /** redis = Redis Streams (local), pubsub = Google Cloud Pub/Sub (GCP). */
  QUEUE: z.enum(["redis", "pubsub"]).default("redis"),
  GCP_PROJECT: z.string().optional(),
  PUBSUB_TOPIC: z.string().default("popup-events"),
  PUBSUB_SUBSCRIPTION: z.string().default("popup-events-writer"),
  /** Codes kept ready in Redis per campaign; the worker refills below the low watermark. */
  POOL_TARGET: z.coerce.number().default(5000),
  POOL_LOW_WATERMARK: z.coerce.number().default(2500),
  /** mock = simulated Shopify store (demo), real = Shopify Admin GraphQL API. */
  SHOPIFY_MODE: z.enum(["mock", "real"]).default("mock"),
  SHOPIFY_API_KEY: z.string().default("demo-client-id"),
  SHOPIFY_API_SECRET: z.string().default("demo-shopify-secret"),
  SHOPIFY_API_VERSION: z.string().default("2026-10"),
  SHOPIFY_SCOPES: z.string().default("write_discounts,read_orders,read_products"),
  APP_URL: z.string().default("http://localhost:8080"),
  /** 32-byte hex key for encrypting stored Shopify access tokens (Secret Manager in GCP). */
  TOKEN_ENC_KEY: z.string().default("0".repeat(64)),
  ADMIN_TOKEN: z.string().default("demo-admin-token"),
  /** vertex = Claude on Vertex AI, anthropic = Claude API, offline = deterministic stand-in (no key). */
  LLM_PROVIDER: z.enum(["vertex", "anthropic", "offline"]).default("offline"),
  VERTEX_REGION: z.string().default("global"),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  CLAUDE_FALLBACK_MODEL: z.string().default("claude-opus-4-8"),
  SERVE_WEB: bool.default(true),
  LOG_LEVEL: z.string().default("info"),
});

export type Config = z.infer<typeof Env>;
export const config: Config = Env.parse(process.env);
