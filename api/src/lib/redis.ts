import { Redis } from "ioredis";
import { config } from "../config.js";

export function createRedis(): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableAutoPipelining: true });
}

export const redis = createRedis();
