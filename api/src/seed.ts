import { db } from "./db/index.js";
import { activate, createDraft } from "./lib/campaignService.js";
import { shopify, DEMO_SHOP } from "./shopify/client.js";

/** Simulated store only: install the demo shop and give it a live campaign on first start. */
export async function seedDemo(): Promise<void> {
  const existing = await db.query("SELECT 1 FROM campaigns WHERE shop_domain = $1 LIMIT 1", [DEMO_SHOP]);
  if (existing.rowCount) return;
  const c = await createDraft({
    shopDomain: DEMO_SHOP,
    name: "Welcome 15%",
    headline: "Take 15% off your first order",
    body: "Join Northwind Running for early access to new shoe drops. Add your number for text-only deals.",
    cta: "Unlock my 15% off",
    discountPercent: 15,
    codePrefix: "RUN15",
    theme: { primary: "#0f766e", background: "#ffffff", text: "#0b1220" },
  });
  await activate(shopify, c.id);
  console.log(`seeded demo campaign ${c.id} for ${DEMO_SHOP}`);
}
