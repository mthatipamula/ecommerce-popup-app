export interface CampaignConfig {
  id: string;
  headline: string;
  body: string;
  cta: string;
  discountPercent: number;
  theme: { primary?: string; background?: string; text?: string };
}

export interface Issued { code: string; discountPercent: number; applyUrl: string; returning: boolean }

export function createApi(base: string, shop: string) {
  return {
    async config(): Promise<CampaignConfig | null> {
      const r = await fetch(`${base}/v1/popup/config?shop=${encodeURIComponent(shop)}`);
      if (!r.ok) return null;
      return (await r.json()).campaign;
    },
    async submit(input: { campaignId: string; email: string; phone: string | null; smsConsent: boolean; visitorId: string }): Promise<Issued> {
      const r = await fetch(`${base}/v1/popup/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, ...input }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? "Something went wrong. Please try again.");
      return body;
    },
    /** Fire-and-forget analytics; sendBeacon survives page navigation. */
    event(campaignId: string, kind: "view" | "close") {
      const payload = JSON.stringify({ shop, campaignId, kind });
      if (!navigator.sendBeacon?.(`${base}/v1/popup/events`, payload)) {
        fetch(`${base}/v1/popup/events`, { method: "POST", body: payload, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
      }
    },
  };
}
export type PopupApi = ReturnType<typeof createApi>;
