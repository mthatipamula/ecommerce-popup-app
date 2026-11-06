import { db } from "../db/index.js";
import { config } from "../config.js";
import { decrypt } from "../lib/crypto.js";
import { randomUUID } from "node:crypto";

export interface ShopProfile {
  name: string;
  currency: string;
  products: { title: string; priceCents: number; productType: string }[];
}

export interface DiscountInput {
  title: string;
  percent: number;
  firstCode: string;
  /** A scheduled campaign's codes only work inside its window, like Shopify's startsAt / endsAt. */
  startsAt?: string | null;
  endsAt?: string | null;
}

/** The slice of Shopify this app needs. Two implementations: the simulated store and the real Admin API. */
export interface ShopifyClient {
  /** One Shopify discount per campaign; individual unique codes are attached to it. */
  createDiscount(shop: string, input: DiscountInput): Promise<string>;
  addCodes(shop: string, discountId: string, codes: string[]): Promise<void>;
  disableCode(shop: string, discountId: string, code: string): Promise<void>;
  shopProfile(shop: string): Promise<ShopProfile>;
}

// ------------------------------------------------------------------ simulated store (SHOPIFY_MODE=mock)

export const DEMO_SHOP = "northwind-running.myshopify.com";

const DEMO_PRODUCTS: ShopProfile["products"] = [
  { title: "Tempo Racer 3 Running Shoe", priceCents: 14000, productType: "Shoes" },
  { title: "Trailblazer GTX Trail Shoe", priceCents: 16500, productType: "Shoes" },
  { title: "Featherweight Running Tee", priceCents: 3800, productType: "Apparel" },
  { title: "Thermal Half-Zip", priceCents: 7200, productType: "Apparel" },
  { title: "Hydration Vest 5L", priceCents: 11000, productType: "Gear" },
  { title: "Merino Crew Socks (3-pack)", priceCents: 2400, productType: "Accessories" },
];

export class MockShopifyClient implements ShopifyClient {
  async createDiscount(shop: string, input: DiscountInput) {
    const id = `gid://shopify/DiscountCodeNode/${randomUUID()}`;
    await db.query(
      "INSERT INTO mock_shopify_discounts (id, shop_domain, title, discount_percent, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, shop, input.title, input.percent, input.startsAt ?? null, input.endsAt ?? null],
    );
    await this.addCodes(shop, id, [input.firstCode]);
    return id;
  }

  async addCodes(shop: string, discountId: string, codes: string[]) {
    await db.query(
      `INSERT INTO mock_shopify_codes (shop_domain, code, discount_id)
       SELECT $1, unnest($2::text[]), $3 ON CONFLICT DO NOTHING`,
      [shop, codes, discountId],
    );
  }

  async disableCode(shop: string, _discountId: string, code: string) {
    await db.query("UPDATE mock_shopify_codes SET disabled = true WHERE shop_domain = $1 AND code = $2", [shop, code]);
  }

  async shopProfile(shop: string): Promise<ShopProfile> {
    return { name: shop === DEMO_SHOP ? "Northwind Running" : shop.replace(".myshopify.com", ""), currency: "USD", products: DEMO_PRODUCTS };
  }
}

// ------------------------------------------------------------------ real store (SHOPIFY_MODE=real)

export class AdminApiShopifyClient implements ShopifyClient {
  private async graphql<T>(shop: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const row = (await db.query("SELECT access_token_enc FROM shops WHERE shop_domain = $1 AND uninstalled_at IS NULL", [shop])).rows[0];
    if (!row?.access_token_enc) throw new Error(`${shop} has not installed the app`);
    const res = await fetch(`https://${shop}/admin/api/${config.SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": decrypt(row.access_token_enc) },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: T; errors?: unknown };
    if (body.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(body.errors)}`);
    return body.data;
  }

  // Field names follow the Admin GraphQL discount API; check them against SHOPIFY_API_VERSION before going live.
  async createDiscount(shop: string, input: DiscountInput) {
    const data = await this.graphql<any>(shop, `
      mutation Create($d: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $d) {
          codeDiscountNode { id }
          userErrors { field message }
        }
      }`, {
      d: {
        title: input.title,
        code: input.firstCode,
        startsAt: input.startsAt ?? new Date().toISOString(),
        ...(input.endsAt ? { endsAt: input.endsAt } : {}),
        context: { all: "ALL" },
        customerGets: { value: { percentage: input.percent / 100 }, items: { all: true } },
        appliesOncePerCustomer: true,
      },
    });
    const r = data.discountCodeBasicCreate;
    if (r.userErrors.length) throw new Error(JSON.stringify(r.userErrors));
    return r.codeDiscountNode.id as string;
  }

  async addCodes(shop: string, discountId: string, codes: string[]) {
    const data = await this.graphql<any>(shop, `
      mutation Add($id: ID!, $codes: [DiscountRedeemCodeInput!]!) {
        discountRedeemCodeBulkAdd(discountId: $id, codes: $codes) {
          bulkCreation { id }
          userErrors { field message }
        }
      }`, { id: discountId, codes: codes.map((code) => ({ code })) });
    const errs = data.discountRedeemCodeBulkAdd.userErrors;
    if (errs.length) throw new Error(JSON.stringify(errs));
  }

  async disableCode(_shop: string, _discountId: string, code: string) {
    // Deleting a single redeem code needs its Shopify ID (a lookup by code first). Out of scope for the demo:
    // the code is marked revoked in our database and the order webhook rejects it as fraud.
    console.warn(`disableCode(${code}): revoked locally only in real mode`);
  }

  async shopProfile(shop: string): Promise<ShopProfile> {
    const data = await this.graphql<any>(shop, `
      query { shop { name currencyCode }
        products(first: 20, sortKey: BEST_SELLING) { nodes { title productType priceRangeV2 { minVariantPrice { amount } } } } }`, {});
    return {
      name: data.shop.name,
      currency: data.shop.currencyCode,
      products: data.products.nodes.map((p: any) => ({
        title: p.title, productType: p.productType,
        priceCents: Math.round(Number(p.priceRangeV2.minVariantPrice.amount) * 100),
      })),
    };
  }
}

export const shopify: ShopifyClient = config.SHOPIFY_MODE === "real" ? new AdminApiShopifyClient() : new MockShopifyClient();
