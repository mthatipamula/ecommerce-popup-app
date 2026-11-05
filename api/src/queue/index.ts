import type { Redis } from "ioredis";
import { config } from "../config.js";

/**
 * Write-behind buffer between the hot request path and Postgres. The API only publishes; the worker
 * consumes in batches and does one multi-row INSERT per batch, so database load grows with batches,
 * not with requests. At-least-once: consumers must be idempotent (inserts use ON CONFLICT).
 */
export type PopupEvent =
  | {
      type: "signup";
      shop: string; campaignId: string; email: string; phone: string | null; smsConsent: boolean;
      visitorId: string | null; ipHash: string; userAgent: string | null; code: string;
      abuseScore: number; at: string;
    }
  | { type: "view" | "close"; shop: string; campaignId: string; at: string }
  | { type: "order"; shop: string; webhookId: string; orderId: string; codes: string[]; totalCents: number; at: string };

export interface EventQueue {
  publish(event: PopupEvent): Promise<void>;
  /** Calls handler with batches; acks only after the handler resolves. */
  consume(handler: (batch: PopupEvent[]) => Promise<void>, opts?: { batchSize?: number }): Promise<() => Promise<void>>;
}

const STREAM = "popup:events";
const GROUP = "writer";

export class RedisStreamQueue implements EventQueue {
  constructor(private readonly redis: Redis, private readonly consumerRedis: Redis) {}

  async publish(event: PopupEvent): Promise<void> {
    // MAXLEN ~ caps memory if the worker falls far behind; sized for minutes of peak traffic.
    await this.redis.xadd(STREAM, "MAXLEN", "~", "5000000", "*", "e", JSON.stringify(event));
  }

  async consume(handler: (batch: PopupEvent[]) => Promise<void>, opts: { batchSize?: number } = {}) {
    const r = this.consumerRedis;
    try {
      await r.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
    } catch (e) {
      if (!String(e).includes("BUSYGROUP")) throw e;
    }
    const consumer = `c-${process.pid}`;
    let running = true;
    const loop = (async () => {
      // Pending entries first (crash recovery), then new ones.
      let cursor = "0";
      while (running) {
        const res = (await r.xreadgroup("GROUP", GROUP, consumer, "COUNT", opts.batchSize ?? 1000, "BLOCK", 1000,
          "STREAMS", STREAM, cursor)) as [string, [string, string[]][]][] | null;
        const entries = res?.[0]?.[1] ?? [];
        if (cursor === "0" && entries.length === 0) { cursor = ">"; continue; }
        if (entries.length === 0) continue;
        const events = entries.map(([, fields]) => JSON.parse(fields[1]) as PopupEvent);
        try {
          await handler(events);
          await r.xack(STREAM, GROUP, ...entries.map(([id]) => id));
          await r.xdel(STREAM, ...entries.map(([id]) => id));
        } catch (e) {
          console.error("event batch failed; will retry", e);
          await new Promise((ok) => setTimeout(ok, 1000));
          cursor = "0";
        }
      }
    })();
    return async () => { running = false; await loop; };
  }
}

/** Google Cloud Pub/Sub: client-side batching on publish, streaming pull with flow control on consume. */
export class PubSubQueue implements EventQueue {
  private topicPromise;
  constructor() {
    this.topicPromise = import("@google-cloud/pubsub").then(({ PubSub }) =>
      new PubSub({ projectId: config.GCP_PROJECT }).topic(config.PUBSUB_TOPIC, {
        batching: { maxMessages: 1000, maxMilliseconds: 20 },
      }),
    );
  }

  async publish(event: PopupEvent): Promise<void> {
    const topic = await this.topicPromise;
    await topic.publishMessage({ json: event });
  }

  async consume(handler: (batch: PopupEvent[]) => Promise<void>, opts: { batchSize?: number } = {}) {
    const { PubSub } = await import("@google-cloud/pubsub");
    const size = opts.batchSize ?? 1000;
    const sub = new PubSub({ projectId: config.GCP_PROJECT }).subscription(config.PUBSUB_SUBSCRIPTION, {
      flowControl: { maxMessages: size * 4 },
    });
    type Msg = { data: Buffer; ack(): void; nack(): void };
    let buf: Msg[] = [];
    let flushing = Promise.resolve();
    const flush = () => {
      if (buf.length === 0) return;
      const batch = buf;
      buf = [];
      flushing = flushing.then(async () => {
        try {
          await handler(batch.map((m) => JSON.parse(m.data.toString()) as PopupEvent));
          batch.forEach((m) => m.ack());
        } catch (e) {
          console.error("event batch failed; nacking for redelivery", e);
          batch.forEach((m) => m.nack());
        }
      });
    };
    sub.on("message", (m: Msg) => { buf.push(m); if (buf.length >= size) flush(); });
    const timer = setInterval(flush, 200);
    return async () => { clearInterval(timer); flush(); await flushing; await sub.close(); };
  }
}

export function createQueue(redis: Redis, consumerRedis: Redis): EventQueue {
  return config.QUEUE === "pubsub" ? new PubSubQueue() : new RedisStreamQueue(redis, consumerRedis);
}
