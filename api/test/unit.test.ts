import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { decrypt, encrypt, newCode, shopifyWebhookHmac, verifyShopifyQueryHmac } from "../src/lib/crypto.js";
import { abuseScore, FLAG_THRESHOLD } from "../src/lib/abuse.js";
import { normalizePhone } from "../src/routes/popup.js";
import { config } from "../src/config.js";

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
