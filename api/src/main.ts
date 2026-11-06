import { config } from "./config.js";
import { migrate, db, withStartupLock } from "./db/index.js";
import { redis, createRedis } from "./lib/redis.js";
import { createQueue } from "./queue/index.js";
import { buildServer } from "./server.js";
import { startWorker } from "./worker.js";
import { seedDemo } from "./seed.js";

/**
 * One image, two roles. In GCP the api and worker run as separate Cloud Run services (ROLE=api / ROLE=worker)
 * so the request path scales on traffic while the worker scales on queue depth. Locally ROLE=all runs both.
 */
async function main() {
  await withStartupLock(async () => {
    await migrate();
    if (config.SHOPIFY_MODE === "mock") await seedDemo();
  });

  const consumerRedis = createRedis(); // blocking XREADGROUP needs its own connection
  const queue = createQueue(redis, consumerRedis);
  const app = await buildServer(queue);

  // Every role listens on PORT: Cloud Run health-checks the worker service too.
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  const stopWorker = config.ROLE === "api" ? null : await startWorker(queue, redis, app.log);

  const shutdown = async () => {
    app.log.info("shutting down");
    await app.close();
    if (stopWorker) await stopWorker();
    await Promise.allSettled([db.end(), redis.quit(), consumerRedis.quit()]);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
