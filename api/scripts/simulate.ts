/**
 * Fill the demo with believable traffic through the public APIs (exactly the calls a browser makes):
 * popup views, ~7% of viewers signing up, ~30% of those redeeming at checkout, plus one bot burst.
 *   npm run simulate -w api -- [visitors] [baseUrl]
 */
import { randomUUID } from "node:crypto";

const visitors = Number(process.argv[2] ?? 600);
const base = process.argv[3] ?? "http://localhost:8080";
const shop = "northwind-running.myshopify.com";
const browser = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15";
const first = ["alex", "sam", "jordan", "taylor", "casey", "riley", "morgan", "jamie", "drew", "avery", "quinn", "rowan"];
const domains = ["gmail.com", "icloud.com", "outlook.com", "yahoo.com"];
const products = ["Tempo Racer 3 Running Shoe", "Trailblazer GTX Trail Shoe", "Featherweight Running Tee", "Hydration Vest 5L", "Merino Crew Socks (3-pack)"];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const ip = () => `73.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}`;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "user-agent": browser, ...headers }, body: JSON.stringify(body) });
  return r.status === 204 ? null : r.json();
}

const cfg = await (await fetch(`${base}/v1/popup/config?shop=${shop}`)).json();
if (!cfg.campaign) throw new Error("no live campaign");
const campaignId = cfg.campaign.id;
let signups = 0;
let orders = 0;

for (let i = 0; i < visitors; i += 20) {
  await Promise.all(Array.from({ length: Math.min(20, visitors - i) }, async () => {
    const xff = { "x-forwarded-for": ip() };
    await post("/v1/popup/events", { shop, campaignId, kind: "view" }, xff);
    if (Math.random() > 0.07) {
      if (Math.random() < 0.6) await post("/v1/popup/events", { shop, campaignId, kind: "close" }, xff);
      return;
    }
    const withPhone = Math.random() < 0.45;
    const email = `${pick(first)}.${randomUUID().slice(0, 6)}@${pick(domains)}`;
    const r = await post("/v1/popup/submit", {
      shop, campaignId, email, phone: withPhone ? `214555${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}` : null,
      smsConsent: withPhone, visitorId: randomUUID(),
    }, xff);
    if (!r?.code) return;
    signups++;
    if (Math.random() < 0.3) {
      await post("/mock-shopify/checkout", { email, items: [{ title: pick(products), qty: 1 + (Math.random() < 0.2 ? 1 : 0) }], discountCode: r.code });
      orders++;
    }
  }));
}

// A code-farming bot: disposable addresses, one network, scripted client.
for (let i = 0; i < 15; i++) {
  await post("/v1/popup/submit", { shop, campaignId, email: `promo${100000 + i}@mailinator.com` },
    { "x-forwarded-for": "203.0.113.77", "user-agent": "python-requests/2.32" });
}
console.log(`simulated ${visitors} visitors: ${signups} sign-ups, ${orders} orders, 15 bot sign-ups`);
