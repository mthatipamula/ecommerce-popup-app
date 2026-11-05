/**
 * Cheap, synchronous signals scored on the request path (no network, no model).
 * Anything suspicious is stored as "flagged" and the abuse agent reviews it later, off the hot path.
 */
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "yopmail.com",
  "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com", "maildrop.cc",
]);

export const FLAG_THRESHOLD = 40;

export function abuseScore(input: { email: string; ipCount: number; userAgent: string | null }): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const [local = "", domain = ""] = input.email.toLowerCase().split("@");
  if (DISPOSABLE.has(domain)) { score += 50; reasons.push("disposable email domain"); }
  if (/\+\d{2,}$/.test(local) || /\d{6,}/.test(local)) { score += 20; reasons.push("generated-looking address"); }
  if (input.ipCount > 10) { score += 30; reasons.push(`${input.ipCount} sign-ups from this IP in the last hour`); }
  else if (input.ipCount > 3) { score += 10; reasons.push(`${input.ipCount} sign-ups from this IP in the last hour`); }
  if (!input.userAgent || /curl|python|httpclient|headless|bot/i.test(input.userAgent)) { score += 25; reasons.push("non-browser user agent"); }
  return { score: Math.min(score, 100), reasons };
}
