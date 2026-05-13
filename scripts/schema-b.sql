-- Part B additive schema. Idempotent — uses IF NOT EXISTS / DO blocks.
-- Run AFTER schema.sql.

-- ────────────────────────────────────────────────────────────────────
-- B1: economics_config — single-row tunable for the pack EV solver.
-- target_margin_bps:  desired house edge (bps of pack price)
-- min_margin_bps:     hard floor below which alerts fire
-- win_rate_floor_bps: minimum fraction of packs where pulled value ≥ price
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS economics_config (
  id                 INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  target_margin_bps  INT NOT NULL DEFAULT 1500,  -- 15%
  min_margin_bps     INT NOT NULL DEFAULT 500,   -- 5%
  win_rate_floor_bps INT NOT NULL DEFAULT 3500,  -- 35%
  last_rebalance_at  TIMESTAMPTZ
);
INSERT INTO economics_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────
-- B4: Provably-fair commit-reveal on packs.
--
-- server_seed_hash : SHA256(server_seed) — committed at purchase, public
-- server_seed      : the raw seed — kept SECRET until the pack is revealed
-- client_seed      : optional user-supplied entropy (defaults to random)
-- nonce            : monotonically increasing per user — prevents replay
-- weights_snapshot : the rarity weights in effect at purchase time
--
-- Why these columns: the user sees server_seed_hash before opening. We
-- cannot retroactively change server_seed because hash(server_seed) must
-- still equal server_seed_hash. The user can recompute everything in the
-- browser after we reveal server_seed at reveal time.
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE user_packs
  ADD COLUMN IF NOT EXISTS server_seed_hash  TEXT,
  ADD COLUMN IF NOT EXISTS server_seed       TEXT,
  ADD COLUMN IF NOT EXISTS client_seed       TEXT,
  ADD COLUMN IF NOT EXISTS nonce             BIGINT,
  ADD COLUMN IF NOT EXISTS weights_snapshot  JSONB,
  ADD COLUMN IF NOT EXISTS card_pool_hash    TEXT;  -- SHA256(sorted card ids) at pull time

-- Monotonic per-user nonce counter (used by buyPack)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pack_nonce       BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bot_score        REAL   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flagged_reason   TEXT,
  ADD COLUMN IF NOT EXISTS flagged_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_request_ip  TEXT,
  ADD COLUMN IF NOT EXISTS last_user_agent  TEXT,
  ADD COLUMN IF NOT EXISTS purchase_count_today INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS purchase_count_reset_at TIMESTAMPTZ;

-- Verification page hits + audit log queries
CREATE INDEX IF NOT EXISTS idx_user_packs_seed_hash ON user_packs(server_seed_hash);

-- ────────────────────────────────────────────────────────────────────
-- B2: rate limit violations and IP tracking.
--
-- We use Redis for the sliding-window counter itself (atomic via Lua).
-- This table is the OUTCOME log — every time someone is blocked we
-- record it for the admin dashboard.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id),
  ip          TEXT,
  endpoint    TEXT NOT NULL,
  outcome     TEXT NOT NULL,    -- 'blocked' | 'throttled' | 'flagged'
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rl_recent  ON rate_limit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_user    ON rate_limit_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_ip      ON rate_limit_events(ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_outcome ON rate_limit_events(outcome, created_at DESC);

-- ────────────────────────────────────────────────────────────────────
-- B3: Auction integrity additions
--
-- sealed_phase_seconds : the LAST N seconds of the auction are sealed —
--                        bids placed are accepted but the amount + bidder
--                        are NOT broadcast to other watchers until the
--                        auction closes. Beats sniping because a bot
--                        learns nothing from observing the room.
-- flagged_reason       : wash-trade flag detail (admin-only)
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS sealed_phase_seconds INT NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS flagged_reason       TEXT,
  ADD COLUMN IF NOT EXISTS flagged_severity     INT,    -- 1..5
  ADD COLUMN IF NOT EXISTS flagged_at           TIMESTAMPTZ;

ALTER TABLE bids
  ADD COLUMN IF NOT EXISTS sealed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rejected_reason TEXT;       -- if bid was rejected at validation

-- Index for finding suspicious cross-account flows
CREATE TABLE IF NOT EXISTS wash_trade_flags (
  id             BIGSERIAL PRIMARY KEY,
  related_kind   TEXT NOT NULL,    -- 'auction' | 'listing'
  related_id     UUID NOT NULL,
  reason         TEXT NOT NULL,
  severity       INT NOT NULL,
  user_a         UUID REFERENCES users(id),
  user_b         UUID REFERENCES users(id),
  flagged_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,
  resolved_action TEXT
);
CREATE INDEX IF NOT EXISTS idx_wt_unresolved ON wash_trade_flags(flagged_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wt_user_a ON wash_trade_flags(user_a, flagged_at DESC);
CREATE INDEX IF NOT EXISTS idx_wt_user_b ON wash_trade_flags(user_b, flagged_at DESC);

-- ────────────────────────────────────────────────────────────────────
-- B5: rolling margin snapshots for the health dashboard.
-- A scheduled worker writes one row per tier per hour.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS margin_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  tier_id         UUID NOT NULL REFERENCES pack_tiers(id),
  window_start    TIMESTAMPTZ NOT NULL,
  window_end      TIMESTAMPTZ NOT NULL,
  packs_sold      INT NOT NULL,
  total_revenue_cents BIGINT NOT NULL,
  total_payout_cents  BIGINT NOT NULL,
  realised_margin_bps INT,            -- (revenue - payout) / revenue * 10000
  target_margin_bps   INT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_margin_tier_time ON margin_snapshots(tier_id, window_end DESC);
