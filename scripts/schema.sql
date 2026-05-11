-- PullVault schema
-- All money is stored as BIGINT cents. Never floats. decimal.js used in app layer.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ────────────────────────────────────────────────────────────────────
-- Users
-- balance_available  : spendable funds
-- balance_held       : locked in active auction bids (released on outbid / loss)
-- INVARIANT: balance_available >= 0  AND  balance_held >= 0
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              TEXT UNIQUE NOT NULL,
  password_hash      TEXT NOT NULL,
  balance_available  BIGINT NOT NULL DEFAULT 0 CHECK (balance_available >= 0),
  balance_held       BIGINT NOT NULL DEFAULT 0 CHECK (balance_held >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────
-- Cards (master catalog mirrored from Pokemon TCG API)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cards (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tcg_id              TEXT UNIQUE NOT NULL,        -- e.g. "swsh4-25"
  name                TEXT NOT NULL,
  set_name            TEXT NOT NULL,
  rarity              TEXT NOT NULL,               -- normalised: common|uncommon|rare|holo|ultra|secret
  image_url           TEXT NOT NULL,
  current_price_cents BIGINT NOT NULL DEFAULT 0,
  last_price_update   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cards_rarity ON cards(rarity);

-- Historical prices for charting + EV recalculation audit
CREATE TABLE IF NOT EXISTS card_price_history (
  id           BIGSERIAL PRIMARY KEY,
  card_id      UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  price_cents  BIGINT NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_price_history_card ON card_price_history(card_id, recorded_at DESC);

-- ────────────────────────────────────────────────────────────────────
-- Pack tiers — fixed product catalog
-- rarity_weights is JSON like {"common":0.50,"uncommon":0.30,...}
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pack_tiers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  price_cents     BIGINT NOT NULL CHECK (price_cents > 0),
  cards_per_pack  INT NOT NULL CHECK (cards_per_pack > 0),
  rarity_weights  JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────
-- Pack drops — scheduled releases with limited inventory
-- The CHECK ensures sold_count never exceeds total_inventory at the
-- DB layer, even if app logic has a bug.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pack_drops (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id         UUID NOT NULL REFERENCES pack_tiers(id),
  total_inventory INT NOT NULL CHECK (total_inventory > 0),
  sold_count      INT NOT NULL DEFAULT 0,
  drop_time       TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|live|sold_out|ended
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT inventory_not_oversold CHECK (sold_count <= total_inventory)
);
CREATE INDEX IF NOT EXISTS idx_drops_status ON pack_drops(status, drop_time);

-- ────────────────────────────────────────────────────────────────────
-- User packs — purchased pack instances
-- contents_json is set ATOMICALLY at purchase time (not at reveal).
-- This prevents users from refreshing to re-roll.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_packs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drop_id       UUID NOT NULL REFERENCES pack_drops(id),
  tier_id       UUID NOT NULL REFERENCES pack_tiers(id),
  price_paid    BIGINT NOT NULL,
  contents_json JSONB NOT NULL,                    -- [{card_id, price_cents_at_pull, rarity}, ...]
  purchased_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revealed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_packs_user ON user_packs(user_id, purchased_at DESC);

-- ────────────────────────────────────────────────────────────────────
-- User cards — owned card inventory
-- status is enforced by partial unique indexes below to prevent a card
-- from being listed AND auctioned at the same time.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_cards (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id              UUID NOT NULL REFERENCES cards(id),
  acquired_price_cents BIGINT NOT NULL,
  acquired_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source               TEXT NOT NULL,                 -- pack|trade|auction
  status               TEXT NOT NULL DEFAULT 'owned'  -- owned|listed|auctioned|sold
);
CREATE INDEX IF NOT EXISTS idx_user_cards_user_status ON user_cards(user_id, status);

-- ────────────────────────────────────────────────────────────────────
-- Marketplace listings (fixed-price)
-- Partial unique index: a card may have at most ONE active listing.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id     UUID NOT NULL REFERENCES users(id),
  user_card_id  UUID NOT NULL REFERENCES user_cards(id),
  price_cents   BIGINT NOT NULL CHECK (price_cents > 0),
  status        TEXT NOT NULL DEFAULT 'active', -- active|sold|cancelled
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_listing_active_card
  ON listings(user_card_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_listings_active ON listings(status, created_at DESC);

-- ────────────────────────────────────────────────────────────────────
-- Auctions
-- version column for optimistic concurrency on bid placement.
-- end_time is server-authoritative.
-- Anti-snipe: if a bid arrives within snipe_window_seconds of end_time,
-- end_time is extended by snipe_extend_seconds.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auctions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id             UUID NOT NULL REFERENCES users(id),
  user_card_id          UUID NOT NULL REFERENCES user_cards(id),
  start_price_cents     BIGINT NOT NULL CHECK (start_price_cents > 0),
  current_bid_cents     BIGINT,
  current_bidder_id     UUID REFERENCES users(id),
  min_increment_cents   BIGINT NOT NULL DEFAULT 100,
  snipe_window_seconds  INT NOT NULL DEFAULT 30,
  snipe_extend_seconds  INT NOT NULL DEFAULT 30,
  start_time            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time              TIMESTAMPTZ NOT NULL,
  status                TEXT NOT NULL DEFAULT 'live', -- live|ended|cancelled
  version               BIGINT NOT NULL DEFAULT 0,    -- optimistic concurrency
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at             TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_auction_active_card
  ON auctions(user_card_id) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS idx_auctions_live_endtime ON auctions(status, end_time);

-- Bid history (audit log)
CREATE TABLE IF NOT EXISTS bids (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id    UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  bidder_id     UUID NOT NULL REFERENCES users(id),
  amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0),
  placed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT NOT NULL DEFAULT 'active' -- active|outbid|winning|won|lost
);
CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids(auction_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_bids_bidder ON bids(bidder_id, placed_at DESC);

-- ────────────────────────────────────────────────────────────────────
-- Ledger — every money movement, append-only, for audit + analytics
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users(id),
  type          TEXT NOT NULL,
  -- pack_purchase | trade_buy | trade_sell | auction_hold | auction_release
  -- | auction_win  | auction_proceeds | platform_fee | deposit
  amount_cents  BIGINT NOT NULL,             -- signed: + credit, - debit
  related_kind  TEXT,                        -- pack|listing|auction|bid
  related_id    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON ledger(type, created_at DESC);

-- ────────────────────────────────────────────────────────────────────
-- Platform revenue rollup (denormalised for the admin dashboard)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_revenue (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,        -- pack_margin|trade_fee|auction_fee
  amount_cents  BIGINT NOT NULL,
  related_kind  TEXT,
  related_id    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_revenue_source ON platform_revenue(source, created_at DESC);

-- ────────────────────────────────────────────────────────────────────
-- Idempotency keys (prevent double-submit on POST endpoints)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id),
  endpoint    TEXT NOT NULL,
  result_json JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
