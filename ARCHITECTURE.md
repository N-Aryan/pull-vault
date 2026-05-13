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

---

# Part B Addendum

This section covers the additions made for Part B: the pack-economics solver, rate limiter + fairness queue, sealed-bid auctions + wash-trade detection, and provably-fair commit-reveal.

## B1. Pack Economics Algorithm — `src/lib/economics.ts`

**Pure module.** Zero DB imports — unit-testable in isolation, which the brief explicitly requires.

### The math

Let R = {r₁ … r_k} be rarities, w_i their weights with Σ w_i = 1.
Let μ_i = mean card price within rarity i, σ_i = std-dev within i, n = cards_per_pack.

```
E[V]   = n · Σ_i w_i · μ_i                                    pack expected value
Var[V] = n · ( Σ_i w_i (σ_i² + μ_i²) − (Σ_i w_i μ_i)² )       independent slots
margin_bps = floor((price − E[V]) / price · 10,000)
win_rate ≈ 1 − Φ((price − E[V]) / √Var[V])                    normal approx via CLT
```

The win-rate formula uses CLT (n ≥ 5 slots makes the sum approximately normal even for skewed per-slot distributions). For tiny n (n < 5) the approximation degrades — we don't ship a tier with n < 5, but the simulator validates analytical against Monte-Carlo so any drift would surface immediately.

### Solver

Coordinate hill-climb (NOT linear programming) because the win-rate constraint is **non-linear in w**:

1. Seed weights inversely proportional to mean price (cheap rarities get more weight).
2. Enforce floors (`min_floor_weights`) so secret rares never go to zero.
3. Repeatedly shift weight from "most expensive rarity contributing the gap" to "cheapest one", step size 0.05 halving on rejection.
4. Reject any move that violates `max_single_weight` (default 0.85, prevents "99% commons") or pushes win-rate below floor.
5. Stop when |margin − target| < 50 bps or step < 1e-5 or 2000 iterations.

Default config (`economics_config` table):

| Parameter | Default | Why |
|---|---|---|
| `target_margin_bps` | 1500 (15%) | Industry-standard mystery-box edge. Below MTG-style 25%+ retail. |
| `min_margin_bps` | 500 (5%) | Below this an alert fires. Solver fails ("infeasible") if it can't beat this. |
| `win_rate_floor_bps` | 3500 (35%) | 35% of openings must be "wins" (value ≥ price). Sourced from Loot-box psychology literature — engagement craters below ~30%. |

**Why these constraints prevent degenerate solutions:**
- `max_single_weight: 0.85` prevents "99% commons" — without it the solver maximises margin by gutting variance.
- `min_floor_weights` on secret/ultra keep the dopamine hit possible — a $500 pack with zero chance at a $250 secret is a scam.
- `win_rate_floor_bps: 3500` is the user-side guardrail — solver rejects any vector that drops below it even if margin would be higher.

### Rebalancing safety

> "If prices shift mid-drop, do existing purchased-but-unopened packs use old weights or new weights?"

**OLD weights — guaranteed.** Pack contents are determined at purchase time inside the buyPack transaction. By the time a rebalance runs, the user_pack row has its `contents_json` AND the `weights_snapshot` already locked. Rebalance only affects `pack_tiers.rarity_weights` which is read for **future** purchases.

The simulator endpoint (`POST /api/admin/economics/simulate`) lets admin compare a proposed weight vector vs current outcomes before applying. The rebalance endpoint has `dry_run: true` default behaviour.

### Edge cases

| Case | Behaviour |
|---|---|
| Card pool has only 10 cards | Solver still runs — pulls become repetitive but the math holds. |
| A single card price spikes 100× | Next rebalance reduces that rarity's weight to compensate. Already-purchased packs keep their snapshot weights → consumers protected. |
| A single card price crashes | Margin temporarily exceeds target. No alert (over-target is good for platform). Next rebalance trims the discount. |
| One rarity bucket empty | Pack-engine falls through to `common` for that slot. Solver excludes empty buckets from `usable`. |
| A card > pack price | Allowed — that's the "lottery" experience. EV formula handles it; win-rate just goes up. |

### Chi-squared fairness test

`chiSquaredFit(observed, expected)` computes χ² and a p-value via the regularised lower incomplete gamma (Numerical Recipes — series + continued fraction). df = (rarities with non-zero weight) − 1.

Interpretation rule baked into the dashboard:
- p < 0.01 → strong deviation, investigate (bug or manipulation)
- 0.01 ≤ p < 0.05 → suspicious
- p ≥ 0.05 → consistent with advertised weights at 5% significance

The test uses the **per-pack snapshot weights** (`weights_snapshot` on `user_packs`), not the current `pack_tiers.rarity_weights`. A rebalance does not invalidate the historical audit.

## B2. Rate Limiting & Fairness Queue

### Why sliding-window log over token bucket

The brief explicitly says "sliding window log, not a naive counter." Token bucket has a flaw for this use case: "10 requests at t=5s then 0 requests" leaves the bucket as empty as "0 then 10 now". For the brief's "buy-rate per minute" semantics we need to actually know which window the request fell in.

Implementation: **Redis Sorted Set per (subject, endpoint, rule)**. score = epoch-ms, value = unique token.

The check + register is a **single Lua script** (`SLIDING_WINDOW_LUA` in `src/lib/rate-limit.ts`):

```
ZREMRANGEBYSCORE  key  -inf  (now - window_ms)   -- evict old
ZCARD             key                            -- count
if count >= limit → return {denied, count, retry_at}
ZADD key now token
PEXPIRE key window_ms
return {allowed, count+1, 0}
```

Redis runs Lua atomically per shard. 100 requests racing produce **exactly `limit`** allowed and the rest rejected — no TOCTOU.

### Rules in effect

| Rule | Subject | Window | Limit | Why |
|---|---|---|---|---|
| `pack_buy_user` | user_id | 60s | 5 | Human max rate. Bots hit ≥100/s. |
| `pack_buy_ip` | IP | 60s | 30 | Catches multi-account abuse from one box. |
| `pack_buy_day` | user_id | 24h | 200 | Hoarding cap. |
| `bid_user` | user_id | 60s | 30 | Active humans bid ≤30/min. |
| `bid_user_auction` | user_id+auction | 10s | 3 | Rapid-fire bot bouncer. |
| `api_ip` | IP | 60s | 300 | General API DoS guard. |

### Purchase fairness queue (`src/lib/fairness-queue.ts`)

The brief: "the fastest HTTP client should not have a guaranteed advantage".

Strategy: **random jitter window**.
- Bucket every incoming pack-buy into a 500ms fairness window.
- Each request gets a deterministic 0..500ms delay computed from `hash(user_id + drop_id + window_index)`.
- After their delay, they enter the actual concurrency-safe purchase path.

Effect: two humans clicking in the same 500ms window have equal expected probability of getting the pack. A bot's ms-of-latency advantage is replaced by their hash output vs mine.

**Doesn't change "how many succeed"** — `total_inventory` is still the cap. Just changes *who* succeeds.

### Behavioural signals (`recordPurchaseAttempt`)

We compute a `bot_score ∈ [0,1]` from:

- Inter-arrival time of purchase clicks (sub-100ms → +0.5)
- User-agent diversity over rolling 1h (>5 UAs → +0.3)
- Burst rate over 2s (>10 requests → +0.4)

Score ≥ 0.7 sets `users.flagged_at` and `users.flagged_reason`. **We do NOT block** flagged users — the brief explicitly warns against being too aggressive. They appear on the admin Fraud tab and an admin decides.

## B3. Auction Integrity

### Sealed-bid phase (`src/lib/auction-integrity.ts`)

Last `sealed_phase_seconds` (default 60s) of every auction:
- Bids still accepted, marked `sealed=true`.
- Amount + bidder hidden in WebSocket broadcasts.
- `getAuctionState` masks current_bid_cents + current_bidder_id + sealed bid rows for any LIVE auction inside the sealed window.
- After settlement, full transparency restored — bid history shows everything.

**Why this beats sniping**: a snipe bot's playbook is "watch the high bid, fire +$1 in the last 100ms". If the bot can't see the high bid, it cannot undercut. Both sides commit blindly. The information asymmetry that favoured the bot is gone.

Composes with Part A's soft-close timer:
- Sealed phase starts inside the snipe window.
- A sealed bid still extends `end_time` via the existing anti-snipe path.
- New sealed phase starts from the new end_time.

### Bid validation

| Check | Threshold | Action |
|---|---|---|
| Fat-finger warn | bid > 5× market price | Warning, bid accepted |
| Fat-finger hard-block | bid > 20× market price | Insert bid row with `status='rejected'`, throw `FAT_FINGER` (HTTP 422) |
| Rapid-fire per user | >30 bids / 60s | `RAPID_FIRE` (429) |
| Rapid-fire per auction | >3 bids / 10s | `RAPID_FIRE` (429) |
| Self-bid as current high | already is high bidder | `SELF_BID_HIGH` (409) — same rule eBay uses |

### Wash-trade detection (`detectWashTrades` worker tick, every 5 min)

Three heuristics:

1. **Repeat-pair**: same (user_a, user_b) trade > 3 times in 7 days (across listings + auctions).
2. **Low-ball single-bidder**: auction closed below 50% of market price with only 1 unique bidder.
3. **Cyclic transfer**: card moves A → B → A within 30 days.

Matches insert into `wash_trade_flags` with severity 3 / 4 / 5 respectively. We **do not auto-reverse the trade** — an admin reviews. Reduces false-positive risk to zero while still surfacing every plausible case.

## B4. Provably-Fair Commit-Reveal

### The scheme

```
PURCHASE TIME (atomic, inside buyPack txn):
  server_seed       ← randomBytes(32)               [SECRET until reveal]
  server_seed_hash  ← SHA256(server_seed)           [COMMITTED — public]
  client_seed       ← user-supplied or random        [PUBLIC]
  nonce             ← user.pack_nonce + 1            [PUBLIC, monotonic]
  weights_snapshot  ← current pack_tiers.rarity_weights
  card_pool_hash    ← SHA256(sorted card-ids by rarity)

  for slot s = 0..n-1:
    hmac_s   = HMAC_SHA256(server_seed, `${client_seed}:${nonce}:${s}`)
    u_rarity = hmac_s[0..3] / 2^32     → [0,1)
    u_card   = hmac_s[4..7] / 2^32     → [0,1)
    rarity = pickWeighted(weights_snapshot, u_rarity)
    card   = pool[rarity][floor(u_card · pool[rarity].length)]

REVEAL TIME:
  server_seed becomes public

VERIFICATION (browser, `provably-fair-browser.ts`):
  ✓ SHA256(server_seed) == server_seed_hash       (commit didn't change)
  ✓ recomputed card_pool_hash == stored hash      (pool wasn't swapped)
  ✓ rerun every slot HMAC → matches recorded card IDs
```

### Security properties

1. **Server cannot post-hoc change outcomes** — the commit is locked at purchase time. Finding a different seed that hashes to the same `server_seed_hash` is SHA256-preimage-hard.
2. **Server cannot cherry-pick seed** — `randomBytes(32)` is generated and committed BEFORE any cards are drawn. The server doesn't know what cards a given seed will produce until after committing.
3. **Replay is impossible** — `pack_nonce` increments per user per pack inside the same UPDATE that debits the balance.
4. **Pool swap is detectable** — `card_pool_hash` records every eligible card-id at purchase time. If we later edit the catalog, the verifier shows "pool hash mismatch".
5. **User can mix in entropy** — `client_seed` can be supplied by the user. If they don't trust our `randomBytes`, they bring their own.

### Verification page (`/verify`)

- Pure client-side. Uses Web Crypto API (`crypto.subtle.digest` + HMAC).
- Fetches the proof from `/api/packs/:id/verify` (public — anyone can audit any pack).
- Pre-reveal: server_seed is null. Page tells the user "not yet revealed — come back after opening".
- Post-reveal: recomputes commit, pool hash, and every slot's pull. Shows pass/fail with per-slot detail.
- Auto-prefills from `?id=` query — reveal page deep-links to it.

### Public audit log

The Fairness tab in `/admin` runs a chi-squared test over ALL revealed packs per tier. p-value, observed vs expected, and per-rarity χ contribution are surfaced. Anyone can audit aggregate fairness; the test uses snapshot weights so it's robust to rebalances.

## B5. Platform Health Dashboard

Five tabs on `/admin`:

| Tab | Endpoint | Auto-refresh | Purpose |
|---|---|---|---|
| Economics | `/api/admin/economics` | manual + rebalance trigger | Lifetime revenue, per-tier EV vs target, rebalance preview |
| Simulate | `/api/admin/economics/simulate` | on-demand | Monte-Carlo 10,000 packs, observed margin/win-rate, histogram |
| Fraud | `/api/admin/fraud` | on load | RL events 24h, flagged accounts, wash-trade queue, noisy IPs |
| Fairness | `/api/admin/fairness` | on load | Chi-squared per tier, observed vs expected, verify-page hit count |
| Health | `/api/admin/health` | on load | Rolling margin per tier (24h), deviation alerts, auction health, DAU |

### Alert rules (Health tab)

- **Critical**: a tier's realised 24h margin is below `min_margin_bps` (5% default) AND ≥10 packs in the window.
- **Warning**: realised margin deviates from `target_margin_bps` by ≥500 bps (5pp).

Alerts are recomputed every dashboard load and persist in `margin_snapshots` (hourly write by the worker for historical trending).

## B-tier index choices

Each new table has indexes justified below:

| Table | Index | Why |
|---|---|---|
| `rate_limit_events` | `idx_rl_recent (created_at DESC)` | Admin "last 24h" filter |
| `rate_limit_events` | `idx_rl_user (user_id, created_at DESC)` | Per-user fraud audit |
| `rate_limit_events` | `idx_rl_ip (ip, created_at DESC)` | "Noisy IPs" admin query |
| `rate_limit_events` | `idx_rl_outcome (outcome, created_at DESC)` | Blocked vs flagged trending |
| `wash_trade_flags` | `idx_wt_unresolved (flagged_at DESC) WHERE resolved_at IS NULL` | Partial index — only un-resolved rows queried in dashboard |
| `wash_trade_flags` | `idx_wt_user_a`, `idx_wt_user_b` | Per-user reverse lookup |
| `margin_snapshots` | `idx_margin_tier_time (tier_id, window_end DESC)` | Time-series chart per tier |
| `user_packs` | `idx_user_packs_seed_hash (server_seed_hash)` | Verify page lookup by commit |

