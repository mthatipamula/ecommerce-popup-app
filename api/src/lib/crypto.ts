import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Shopify signs webhook bodies with the app secret: base64(HMAC-SHA256(rawBody)). */
export function shopifyWebhookHmac(rawBody: Buffer | string, secret = config.SHOPIFY_API_SECRET): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** OAuth callback: hex HMAC of the sorted query string without `hmac`. */
export function verifyShopifyQueryHmac(query: Record<string, string>): boolean {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("&");
  const digest = createHmac("sha256", config.SHOPIFY_API_SECRET).update(message).digest("hex");
  return safeEqual(digest, hmac);
}

const key = () => Buffer.from(config.TOKEN_ENC_KEY, "hex");

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// No 0/O/1/I: codes get read aloud and typed on phones.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newCode(prefix: string, length = 8): string {
  let s = "";
  for (let i = 0; i < length; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${s}`;
}
