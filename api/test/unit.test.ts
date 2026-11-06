import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { decrypt, encrypt, newCode, shopifyWebhookHmac, verifyShopifyQueryHmac } from "../src/lib/crypto.js";
import { abuseScore, FLAG_THRESHOLD } from "../src/lib/abuse.js";
import { normalizePhone } from "../src/routes/popup.js";
import { config } from "../src/config.js";
import { addDays, parseSchedule, scheduleWindow, todayIn } from "../src/lib/schedule.js";

describe("Shopify signatures", () => {
  it("signs webhook bodies as base64 HMAC-SHA256 with the app secret", () => {
    const body = '{"id":1}';
    expect(shopifyWebhookHmac(body)).toBe(createHmac("sha256", config.SHOPIFY_API_SECRET).update(body).digest("base64"));
  });

  it("verifies the OAuth callback query HMAC and rejects tampering", () => {
    const q = { code: "abc", shop: "demo.myshopify.com", state: "s1", timestamp: "1700000000" };
    const msg = Object.keys(q).sort().map((k) => `${k}=${q[k as keyof typeof q]}`).join("&");
    const hmac = createHmac("sha256", config.SHOPIFY_API_SECRET).update(msg).digest("hex");
    expect(verifyShopifyQueryHmac({ ...q, hmac })).toBe(true);
    expect(verifyShopifyQueryHmac({ ...q, shop: "evil.myshopify.com", hmac })).toBe(false);
    expect(verifyShopifyQueryHmac(q)).toBe(false);
  });
});

describe("token encryption", () => {
  it("round-trips and uses a fresh IV every time", () => {
    const a = encrypt("shpat_secret");
    expect(decrypt(a)).toBe("shpat_secret");
    expect(encrypt("shpat_secret")).not.toBe(a);
  });
});

describe("discount codes", () => {
  it("have the prefix and no ambiguous characters", () => {
    for (let i = 0; i < 200; i++) expect(newCode("RUN15")).toMatch(/^RUN15-[A-HJ-NP-Z2-9]{8}$/);
  });
});

describe("phone normalisation", () => {
  it.each([
    ["(214) 555-0134", "+12145550134"],
    ["1 214 555 0134", "+12145550134"],
    ["+44 20 7946 0958", "+442079460958"],
    ["", null],
    [null, null],
    ["12", "invalid"],
  ])("%s -> %s", (raw, out) => expect(normalizePhone(raw)).toBe(out));
});

describe("abuse rules", () => {
  it("lets a normal shopper through", () => {
    expect(abuseScore({ email: "jane@gmail.com", ipCount: 1, userAgent: "Mozilla/5.0" }).score).toBeLessThan(FLAG_THRESHOLD);
  });
  it("flags a disposable address", () => {
    expect(abuseScore({ email: "x@mailinator.com", ipCount: 1, userAgent: "Mozilla/5.0" }).score).toBeGreaterThanOrEqual(FLAG_THRESHOLD);
  });
  it("flags scripted bursts from one network", () => {
    const r = abuseScore({ email: "deal88812@gmail.com", ipCount: 25, userAgent: "python-requests/2.31" });
    expect(r.score).toBeGreaterThanOrEqual(FLAG_THRESHOLD);
    expect(r.reasons.length).toBeGreaterThan(1);
  });
});

describe("campaign schedules", () => {
  const today = "2026-11-05"; // a Thursday

  it("reads dates and lengths from plain English", () => {
    expect(parseSchedule("Welcome 20% on Nov 20", today)).toEqual({ startDate: "2026-11-20", days: 1, label: null });
    expect(parseSchedule("Welcome 20% off for 15 days starting tomorrow", today)).toEqual({ startDate: "2026-11-06", days: 15, label: null });
    expect(parseSchedule("20% for 15 consecutive days from 2026-12-01", today)).toMatchObject({ startDate: "2026-12-01", days: 15 });
    expect(parseSchedule("run it 3rd of January for a week", today)).toMatchObject({ startDate: "2027-01-03", days: 7 });
    expect(parseSchedule("Draft a Black Friday popup with 20% off", today)).toEqual({ startDate: "2026-11-27", days: 1, label: "Black Friday" });
    expect(parseSchedule("Cyber Monday 25%", today)).toMatchObject({ startDate: "2026-11-30" });
    expect(parseSchedule("Take 15% off your first order", today)).toBeNull();
    expect(parseSchedule("open 24/7 deal", today)).toBeNull();
  });

  it("turns days into midnight-to-midnight windows in the merchant's time zone, across DST", () => {
    expect(scheduleWindow("2026-11-20", 1, "America/Chicago")).toEqual({ startsAt: "2026-11-20T06:00:00.000Z", endsAt: "2026-11-21T06:00:00.000Z" });
    // US clocks go back on Nov 1 2026: the window still starts and ends at local midnight.
    expect(scheduleWindow("2026-10-30", 5, "America/Chicago")).toEqual({ startsAt: "2026-10-30T05:00:00.000Z", endsAt: "2026-11-04T06:00:00.000Z" });
    expect(scheduleWindow("2026-12-01", 15, "Asia/Kolkata").startsAt).toBe("2026-11-30T18:30:00.000Z");
    expect(addDays("2026-12-25", 15)).toBe("2027-01-09");
    expect(todayIn("Pacific/Auckland", new Date("2026-11-05T12:00:00Z"))).toBe("2026-11-06");
  });
});
