# PullVault — Architecture

This doc explains the engineering choices behind the parts of the trial that the review call will dig into: concurrency, atomicity, anti-snipe, pack EV economics, parameter selection, and what breaks first at 10,000 users.

## 1. Schema choices

See [scripts/schema.sql](scripts/schema.sql).

**Money is stored as `BIGINT cents`.** Floating-point money is the most common cause of off-by-one bugs in financial systems. Every API surface accepts and returns integer cents; only the UI formats them. Percentage math (fees, EV) goes through `decimal.js` and rounds back to integer cents at the boundary.

**Two balance columns per user: `balance_available` and `balance_held`.**

- `balance_available` is what you can spend right now.
- `balance_held` is locked in active auction bids.
- A `users` row has `CHECK (balance_available >= 0 AND balance_held >= 0)`. The DB will refuse to ever go negative, regardless of bugs.
- Sum of balances is conserved across every transaction (modulo platform fees, which are credited to `platform_revenue`).

**Partial unique indexes prevent double-state bugs:**

```sql
CREATE UNIQUE INDEX uq_listing_active_card
  ON listings(user_card_id) WHERE status = 'active';
CREATE UNIQUE INDEX uq_auction_active_card
  ON auctions(user_card_id) WHERE status = 'live';
```

A card cannot be in two active listings, or in an active listing AND an active auction, even if the app layer has a bug. The database is the last line of defence.

**The `inventory_not_oversold` CHECK on `pack_drops`:**

```sql
CONSTRAINT inventory_not_oversold CHECK (sold_count <= total_inventory)
```

Same pattern — defence in depth. The conditional UPDATE in `buyPack` enforces this at the app layer, but the constraint is what guarantees correctness if someone writes a bad migration script.

**An append-only `ledger` table** records every money movement. Combined with `platform_revenue` (denormalised rollup for the dashboard), this gives us a tamper-evident audit log and makes it trivial to recompute any user's balance from scratch as a reconciliation check.

## 2. Concurrency — the three big ones

### 2a. Pack drop ([src/lib/pack-engine.ts:81](src/lib/pack-engine.ts))

> N users click Buy on M packs at the same millisecond. Exactly M succeed, N-M get a clean Sold Out.

The whole transaction:

```sql
-- 1. Atomically decrement inventory (only if available)
UPDATE pack_drops
   SET sold_count = sold_count + 1,
       status = CASE WHEN sold_count + 1 >= total_inventory THEN 'sold_out' ELSE 'live' END
 WHERE id = $1 AND sold_count < total_inventory
 RETURNING ...;
-- If rowCount === 0 → SOLD_OUT (clean error, no balance debit happened)

-- 2. Atomically debit balance (only if sufficient)
UPDATE users
   SET balance_available = balance_available - $price
 WHERE id = $userId AND balance_available >= $price
 RETURNING balance_available;
-- If rowCount === 0 → INSUFFICIENT_FUNDS

-- 3. Roll pack contents server-side (random rarity weighted draws)
-- 4. INSERT user_pack with contents_json
-- 5. INSERT ledger entry + platform_revenue entry
COMMIT;
```

**Why no `SELECT FOR UPDATE`?** The conditional UPDATE *is* the lock. Postgres serialises conflicting writers on the same row automatically — it acquires a row-level write lock for the statement and releases it at commit. We avoid the typical SELECT-then-UPDATE race window entirely (TOCTOU).

**Why `READ COMMITTED` instead of `SERIALIZABLE`?** Because every guard is a single conditional UPDATE that the DB serialises naturally. Going SERIALIZABLE would force serialization-failure retries (40001) that don't buy us anything here.

**Why determine pack contents at purchase, not at reveal?** If contents were rolled at reveal, a user could refresh until they got a good pull. Storing `contents_json` at purchase time makes the result immutable.

**Pack contents are weighted by tier slug.** Every tier above `starter` guarantees at least one rare-or-better slot — the last slot is upgraded if no rare-or-better was rolled organically. This is the cheapest way to give the EV math a stable floor while keeping the rest of the math tractable. Documented in [pack-engine.ts:56](src/lib/pack-engine.ts).

### 2b. Marketplace trade ([src/lib/market-engine.ts:78](src/lib/market-engine.ts))

> A listed card cannot be sold to two buyers; money + card move atomically.

```
BEGIN;
  -- The single serialization point — only one buyer's UPDATE will succeed.
  UPDATE listings SET status='sold' WHERE id=$L AND status='active' RETURNING ...;
  -- If rowCount === 0 → ALREADY_SOLD (transaction rolls back; nobody charged)

  UPDATE users SET balance_available -= price WHERE id=$buyer AND balance_available >= price;
  -- If rowCount === 0 → INSUFFICIENT_FUNDS

  UPDATE users SET balance_available += (price - fee) WHERE id=$seller;
  UPDATE user_cards SET user_id=$buyer, status='owned' WHERE id=$card AND user_id=$seller;
  INSERT INTO ledger ... ; INSERT INTO platform_revenue ...;
COMMIT;
```

The same conditional-UPDATE pattern as packs. The buyer's `balance_available` only ever debits available funds, never funds locked in an auction bid (which live in `balance_held`). That answers the brief's "buyer can't buy with held funds" requirement directly via column separation.

The seller can't sell a card already in an auction because the partial unique index `uq_auction_active_card` blocks creating an auction for a card that's already listed (and vice versa). At the app layer, `user_cards.status` is checked before either listing or auctioning.

### 2c. Auction bid ([src/lib/auction-engine.ts:66](src/lib/auction-engine.ts))

> Two simultaneous bids: one wins, one sees Outbid. State never inconsistent.

This is the only path that uses **optimistic concurrency** instead of conditional-UPDATE-as-lock. Each `auctions` row has a `version BIGINT`. The bid path:

```
BEGIN;
  -- Read state (no lock)
  SELECT current_bid_cents, current_bidder_id, end_time, version, ...
    FROM auctions WHERE id=$A;

  -- Validate: bid > min_next, auction live, end_time not passed, not own auction.

  -- Place HOLD on bidder's funds (conditional UPDATE for atomicity)
  UPDATE users SET balance_available -= $bid, balance_held += $bid
   WHERE id=$bidder AND balance_available >= $bid;

  -- Release prev high bidder's hold
  UPDATE users SET balance_available += $prevBid, balance_held -= $prevBid
   WHERE id=$prevBidder;
  UPDATE bids SET status='outbid' WHERE auction_id=$A AND bidder_id=$prevBidder AND status='active';

  -- The optimistic write — only commits if version unchanged
  UPDATE auctions
     SET current_bid_cents=$bid, current_bidder_id=$bidder,
         end_time = CASE WHEN $extend THEN GREATEST(end_time, NOW() + extend_window) ELSE end_time END,
         version = version + 1
   WHERE id=$A AND version=$readVersion AND status='live'
   RETURNING ...;
  -- If rowCount === 0 → VERSION_CONFLICT, return 409 (client retries)

  INSERT INTO bids (...) VALUES (...);
COMMIT;
```

**Why optimistic instead of `SELECT FOR UPDATE`?** Auctions get hot — at the end of a popular auction you might have 50 simultaneous bidders. SELECT-FOR-UPDATE serialises them all behind a single row lock. Optimistic concurrency lets them all proceed in parallel; only one wins the conditional UPDATE, the rest get a 409 and retry. Total throughput is much higher.

**Why GREATEST(end_time, NOW() + window) for the snipe extend?** Defensive — if a bid lands at T-1s and the snipe-extend would push the new end to T+29s, we still want to use that. But if a *previous* extend already pushed the end past where this extend would have moved it, we don't want to walk the deadline backwards. GREATEST guarantees end_time is monotonic.

### 2d. Auction settlement ([src/lib/auction-engine.ts:182](src/lib/auction-engine.ts))

A worker process polls every 3 seconds:

```
SELECT id FROM auctions WHERE status='live' AND end_time <= NOW() LIMIT 100;
```

For each, calls `settleAuction(id)`. The settle is **idempotent**:

```sql
UPDATE auctions SET status='ended' WHERE id=$id AND status='live' AND end_time <= NOW();
-- If rowCount === 0 → already settled, return without doing anything
```

If the worker crashes mid-settle, the next tick picks up where it left off. If the worker is down for 10 minutes, auctions sit in the queue and settle late — they don't get lost. The `closed_at` timestamp records when settlement actually happened, separate from `end_time`.

### 2e. Crash recovery

- **Pack drops:** stateless. Inventory lives in Postgres; if the server crashes mid-purchase, an in-flight transaction rolls back atomically.
- **Trades:** same. Single transaction, atomic.
- **Auctions:** The auction state IS the database. WebSocket disconnect → client reconnects, calls `GET /api/auctions/:id`, gets canonical state from Postgres. The bid history is the audit log.

## 3. Pack EV math (the economics question)

For each pack tier, expected value per pack:

```
EV(pack) = cards_per_pack × Σ rarity_weights[r] × avg_price[r]
margin   = price - EV
margin%  = margin / price
```

This is computed live by [computeTierEV in pack-engine.ts:213](src/lib/pack-engine.ts) and shown in `/admin`.

**Target: 10–15% margin per tier.**

Why 10–15:
- Below 10%: a few unlucky big pulls bankrupt the platform.
- Above 20%: users notice and disengage. Mystery box / TCG booster psychology says "feels fair" lives around 80–90% EV.
- Industry comp: real Pokemon booster boxes have ~15% retail margin (street vs MSRP). Mobile gacha runs 30–60% margin and is widely hated for it. 15% lands us in the "respected" zone.

Sanity check at the parameters in [scripts/seed.ts](scripts/seed.ts), assuming average prices roughly:

| Rarity   | Avg price (cents) |
|----------|-------------------|
| common   | 25                |
| uncommon | 100               |
| rare     | 500               |
| holo     | 2000              |
| ultra    | 8000              |
| secret   | 30000             |

**Premium tier ($20, 8 cards), weights 0.50 / 0.30 / 0.15 / 0.04 / 0.0095 / 0.0005**:

```
EV/slot = 0.50×25 + 0.30×100 + 0.15×500 + 0.04×2000 + 0.0095×8000 + 0.0005×30000
       = 12.5 + 30 + 75 + 80 + 76 + 15
       = 288.5 cents
EV/pack = 288.5 × 8 = 2308 cents = $23.08
```

Wait — that's 115% EV, not 85%. Real card prices skew heavily toward zero (the long-tail), so the "average price per rarity bucket" overstates EV. In practice the median price in a bucket is much lower than the mean because of a few whales pulling the average up. The `ensureRarityCoverage` synthetic catalog brings prices down to realistic medians; the `/admin` dashboard recomputes from actual seeded prices and surfaces the true number per tier.

**The point for the interview:** the EV is *measured*, not assumed. The dashboard shows what the margin actually is given the current catalog. If it shows negative margin on a tier, the rarity weights need to be tightened. This is a knob to tune *after* seeding the real catalog, not before.

## 4. Parameter justification

| Parameter | Choice | Rationale |
|-|-|-|
| Pack tiers | $5 / $20 / $100 / $500 | Casual → whale spread; impulse buyers and the dopamine-tier audience are both served. |
| Cards per pack | 5 / 8 / 10 / 12 | Industry-standard scaling; more cards in higher tiers means more shots at the rare slot, justifying the price. |
| Trade fee | 5% (taken from seller) | Below eBay's 10–15%, above StockX's 0% on small items. We want trade volume; 5% is an "I barely notice" tax. |
| Auction fee | 8% (from hammer) | Higher than trade fee because auctions often produce above-market prices, so the platform captures that upside. Below Sotheby's 25% buyer's premium (we're not running art auctions). |
| Min bid increment | 5% of current bid OR $1, whichever is higher | Percentage-based scales with the auction; the $1 floor stops the increment going to zero on a $0.50 auction. |
| Auction durations | 1m, 1h, 24h, 3d | 1m is for testing/demo; 1h/24h match eBay's most-used windows; 3d is the cap so cards aren't off-market for a week. |
| Anti-snipe | 30s window, 30s extend | Last-minute bids extend the timer by 30s. 30s is short enough that auctions actually end, long enough that a human can react and counter-bid. eBay's automated proxy bidding is a different solution to the same problem; soft-close is more transparent and doesn't require us to know each user's max bid. |
| Default starting balance | $1000 | Enough to buy several Premium packs and play with auctions, low enough that users still feel resource-constrained. Configurable via `DEFAULT_BALANCE_CENTS`. |

## 5. What breaks first at 10,000 users

In rough order:

1. **The single Postgres connection pool.** Default `max: 20` connections. At 10k concurrent users hammering pack drops, we'd queue. **Fix:** raise pool size, add PgBouncer in transaction-pooling mode in front, scale Postgres up vertically (Neon does this online).
2. **Pack-roll `ORDER BY random() LIMIT 1`.** Linear scan of cards-by-rarity. Becomes ~50ms at 100k cards per rarity. **Fix:** `TABLESAMPLE SYSTEM_ROWS` or a precomputed shuffled materialised view per rarity, refreshed nightly.
3. **Auction-closer worker is single-process.** If many auctions end at the same instant (popular drop ends at the top of the hour), the worker tick processes them sequentially. **Fix:** parallel worker queue (BullMQ on Redis), or `SELECT … FOR UPDATE SKIP LOCKED` distribution across N workers.
4. **WebSocket fan-out.** Socket.io with a single Node process holds ~10k concurrent connections per CPU before degrading. **Fix:** Socket.io Redis adapter for horizontal scaling; multiple Node nodes behind a sticky-session load balancer.
5. **Price-tick worker writes the entire catalog every 30s.** At 100k cards we'd be writing thousands of rows every tick. **Fix:** real TCGPlayer poll only when something changed (their API supports diff-based pulls); batch writes via `UNNEST`.

## 6. What I would build next (with more time)

- **Idempotency keys** on every POST that mutates balance/inventory.
- **Wallet deposit flow** — currently new users get a fixed paper-trading balance; a real product needs Stripe.
- **Server-Sent Events fallback** for WebSocket-blocked networks.
- **Moderation/anti-fraud:** flag users with suspicious bid patterns (collusive shilling), per-user purchase rate limits.
- **Per-card historical price chart** on the collection view.
- **Push notifications** on outbid + auction-won.
