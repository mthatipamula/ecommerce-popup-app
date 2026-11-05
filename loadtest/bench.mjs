// Local benchmark of the hot path (POST /v1/popup/submit) on ONE Node process.
// Every request is a new shopper: unique email, random client IP (X-Forwarded-For), browser user agent.
//   node loadtest/bench.mjs [url] [seconds] [connections]
import autocannon from "autocannon";
import { randomUUID } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:8080";
const duration = Number(process.argv[3] ?? 20);
const connections = Number(process.argv[4] ?? 100);
const shop = process.env.SHOP ?? "northwind-running.myshopify.com";

const cfg = await (await fetch(`${base}/v1/popup/config?shop=${shop}`)).json();
const campaignId = cfg.campaign.id;
const ip = () => `100.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}`;

const result = await autocannon({
  url: `${base}/v1/popup/submit`,
  duration,
  connections,
  pipelining: 1,
  requests: [{
    method: "POST",
    setupRequest: (req) => ({
      ...req,
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (bench)", "x-forwarded-for": ip() },
      body: JSON.stringify({ shop, campaignId, email: `bench-${randomUUID()}@example.com`, phone: "2145550100", smsConsent: true }),
    }),
  }],
});
const codes = result.statusCodeStats ?? {};
console.log(JSON.stringify({
  requestsPerSec: Math.round(result.requests.average),
  latencyMs: { p50: result.latency.p50, p90: result.latency.p90, p99: result.latency.p99 },
  total: result.requests.total, non2xx: result.non2xx, errors: result.errors, timeouts: result.timeouts, statusCodes: Object.keys(codes),
}, null, 2));
