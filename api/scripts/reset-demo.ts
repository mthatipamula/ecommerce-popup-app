/** Wipe the demo database and Redis, then reseed the simulated store with one live campaign. */
import { db, migrate } from "../src/db/index.js";
import { redis } from "../src/lib/redis.js";
import { seedDemo } from "../src/seed.js";
import { config } from "../src/config.js";

if (config.SHOPIFY_MODE !== "mock") throw new Error("reset-demo only runs against the simulated store");
await migrate();
await db.query(`TRUNCATE signups, discount_codes, offer_recommendations, popup_events, agent_runs, webhook_deliveries,
  mock_shopify_orders, mock_shopify_codes, mock_shopify_discounts, campaigns, shops CASCADE`);
await redis.flushdb();
await seedDemo();
console.log("demo reset");
await Promise.allSettled([db.end(), redis.quit()]);
