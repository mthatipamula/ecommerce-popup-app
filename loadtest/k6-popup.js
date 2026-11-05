// 10k requests/s against a deployed API (needs k6: https://k6.io). Ramps up, holds, checks error rate and latency.
//   k6 run -e BASE=https://popup-api-xxxx.a.run.app -e CAMPAIGN=<id> loadtest/k6-popup.js
import http from "k6/http";
import { check } from "k6";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE = __ENV.BASE;
const SHOP = __ENV.SHOP || "northwind-running.myshopify.com";
const CAMPAIGN = __ENV.CAMPAIGN;

export const options = {
  scenarios: {
    signups: {
      executor: "ramping-arrival-rate",
      startRate: 500, timeUnit: "1s", preAllocatedVUs: 2000, maxVUs: 6000,
      stages: [{ target: 10000, duration: "2m" }, { target: 10000, duration: "5m" }, { target: 0, duration: "30s" }],
    },
  },
  thresholds: { http_req_failed: ["rate<0.001"], http_req_duration: ["p(95)<150", "p(99)<300"] },
};

export default function () {
  const ip = `100.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  const res = http.post(`${BASE}/v1/popup/submit`, JSON.stringify({
    shop: SHOP, campaignId: CAMPAIGN, email: `k6-${uuidv4()}@example.com`, phone: "2145550100", smsConsent: true,
  }), { headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (k6)", "X-Forwarded-For": ip } });
  check(res, { "got a code": (r) => r.status === 200 && !!r.json("code") });
}
