-- Idempotent schema (CREATE ... IF NOT EXISTS) so every deploy can run it.

CREATE TABLE IF NOT EXISTS shops (
  shop_domain      text PRIMARY KEY,
  access_token_enc text,                 -- AES-256-GCM, key from Secret Manager
  scopes           text,
  installed_at     timestamptz NOT NULL DEFAULT now(),
  uninstalled_at   timestamptz
);

CREATE TABLE IF NOT EXISTS campaigns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_domain         text NOT NULL REFERENCES shops(shop_domain),
  name                text NOT NULL,
  status              text NOT NULL DEFAULT 'draft',       -- draft | active | paused
  discount_percent    int  NOT NULL CHECK (discount_percent BETWEEN 1 AND 90),
  code_prefix         text NOT NULL DEFAULT 'WELCOME',
  shopify_discount_id text,                                -- gid://shopify/DiscountCodeNode/...
  headline            text NOT NULL,
  body                text NOT NULL,
  cta                 text NOT NULL,
  theme               jsonb NOT NULL DEFAULT '{}',
  created_by          text NOT NULL DEFAULT 'human',       -- human | campaign-agent
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- At most one live campaign per shop.
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_one_active ON campaigns (shop_domain) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS discount_codes (
  code              text NOT NULL,
  shop_domain       text NOT NULL,
  campaign_id       uuid NOT NULL REFERENCES campaigns(id),
  status            text NOT NULL DEFAULT 'available',     -- available | issued | redeemed | revoked
  created_at        timestamptz NOT NULL DEFAULT now(),
  issued_at         timestamptz,
  redeemed_at       timestamptz,
  order_id          text,
  order_total_cents bigint,
  PRIMARY KEY (shop_domain, code)
);
CREATE INDEX IF NOT EXISTS discount_codes_campaign_status ON discount_codes (campaign_id, status);

CREATE TABLE IF NOT EXISTS signups (
  id           bigserial PRIMARY KEY,
  shop_domain  text NOT NULL,
  campaign_id  uuid NOT NULL,
  email        text NOT NULL,
  phone        text,
  sms_consent  boolean NOT NULL DEFAULT false,
  visitor_id   text,
  ip_hash      text,
  user_agent   text,
  code         text NOT NULL,
  abuse_score  int  NOT NULL DEFAULT 0,
  abuse_status text NOT NULL DEFAULT 'ok',                 -- ok | flagged | allowed | blocked
  created_at   timestamptz NOT NULL,
  UNIQUE (campaign_id, email)
);
CREATE INDEX IF NOT EXISTS signups_flagged ON signups (abuse_status) WHERE abuse_status = 'flagged';
CREATE INDEX IF NOT EXISTS signups_campaign_time ON signups (campaign_id, created_at);

CREATE TABLE IF NOT EXISTS popup_events (                  -- views / closes, aggregated per hour
  campaign_id uuid NOT NULL,
  hour        timestamptz NOT NULL,
  kind        text NOT NULL,
  count       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, hour, kind)
);

CREATE TABLE IF NOT EXISTS offer_recommendations (
  id               bigserial PRIMARY KEY,
  campaign_id      uuid NOT NULL REFERENCES campaigns(id),
  discount_percent int  NOT NULL,
  rationale        text NOT NULL,
  status           text NOT NULL DEFAULT 'proposed',        -- proposed | applied | dismissed
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id          bigserial PRIMARY KEY,
  agent       text NOT NULL,
  provider    text NOT NULL,
  input       jsonb NOT NULL,
  output      text,
  tool_calls  jsonb NOT NULL DEFAULT '[]',
  error       text,
  duration_ms int,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (            -- Shopify retries; process each delivery once
  webhook_id  text PRIMARY KEY,
  topic       text NOT NULL,
  shop_domain text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Simulated Shopify store (SHOPIFY_MODE=mock): what Shopify itself would hold.
CREATE TABLE IF NOT EXISTS mock_shopify_discounts (
  id               text PRIMARY KEY,
  shop_domain      text NOT NULL,
  title            text NOT NULL,
  discount_percent int  NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mock_shopify_codes (
  shop_domain text NOT NULL,
  code        text NOT NULL,
  discount_id text NOT NULL REFERENCES mock_shopify_discounts(id),
  usage_count int  NOT NULL DEFAULT 0,
  disabled    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (shop_domain, code)
);
CREATE TABLE IF NOT EXISTS mock_shopify_orders (
  id             bigserial PRIMARY KEY,
  shop_domain    text NOT NULL,
  email          text,
  subtotal_cents bigint NOT NULL,
  discount_cents bigint NOT NULL,
  total_cents    bigint NOT NULL,
  discount_code  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
