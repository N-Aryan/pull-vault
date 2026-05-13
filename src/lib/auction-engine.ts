import { withTxRetry, pool } from "@/lib/db";
import { applyFeeBps, FEES, minNextBidCents } from "@/lib/money";
import { pub, Channels } from "@/lib/redis";
import {
  validateAmount,
  checkBidRateLimits,
  isSealedPhase,
  IntegrityError,
} from "@/lib/auction-integrity";

/**
 * Auction Engine
 * ──────────────
 * Real-time competitive bidding. The hardest engineering problem in the trial.
 *
 * State machine:
 *   live → ended (or cancelled if seller withdraws before any bid)
 *
 * Concurrency strategy: optimistic concurrency on auctions.version.
 *   - Bid call reads version V.
 *   - Bid call computes the new state assuming V is still current.
 *   - Bid call updates ROW WHERE version = V, sets version = V+1.
 *   - If the WHERE doesn't match (someone else bid first), retry.
 * This is faster than SELECT FOR UPDATE under heavy contention because the
 * losing bidder's transaction never holds locks across network latency.
 *
 * Balance hold/release lifecycle:
 *   - When user A bids $X: balance_available -= X, balance_held += X.
 *   - When user A is OUTBID: balance_available += X, balance_held -= X.
 *   - When the auction ENDS:
 *       Winner: balance_held -= final_bid (already debited from available).
 *               Card moves to winner.
 *       Loser:  no-op (already released on outbid).
 *               Sellers receive (final_bid - auction_fee) into balance_available.
 *
 * Anti-snipe ("soft-close"):
 *   If a bid is placed within `snipe_window_seconds` of end_time, end_time
 *   is extended by `snipe_extend_seconds`. This repeats for every bid in
 *   the window — the auction can only close after a quiet period.
 *
 *   Why soft-close over hard-close-with-proxy-bidding (eBay-style):
 *   - It's transparent to users; they see the timer extend.
 *   - It doesn't require us to know each bidder's "max bid".
 *   - It eliminates last-millisecond network-race wins entirely.
 *
 * Crash recovery: an auctioneer worker (see auction-closer.ts) polls for
 * auctions with end_time <= NOW() AND status='live' every few seconds and
 * settles them. The settlement is itself idempotent (status check inside
 * the txn). So if the server crashes mid-settle, the next poll finishes it.
 */

export class AuctionError extends Error {
  constructor(
    public code:
      | "AUCTION_NOT_FOUND"
      | "AUCTION_NOT_LIVE"
      | "AUCTION_ENDED"
      | "BID_TOO_LOW"
      | "INSUFFICIENT_FUNDS"
      | "OWN_AUCTION"
      | "VERSION_CONFLICT"
      | "CARD_NOT_AVAILABLE"
      | "MIN_DURATION",
    msg: string,
  ) {
    super(msg);
  }
}

export async function createAuction(opts: {
  userId: string;
  userCardId: string;
  startPriceCents: number;
  durationSeconds: number;
}) {
  if (opts.startPriceCents <= 0) throw new AuctionError("BID_TOO_LOW", "Start price must be positive");
  if (opts.durationSeconds < 60) throw new AuctionError("MIN_DURATION", "Auction must be at least 1 minute");

  return withTxRetry(async (client) => {
    // Lock the card by flipping its status. Same trick as listings — the
    // partial unique index guarantees one auction per card at a time.
    const flip = await client.query(
      `UPDATE user_cards SET status = 'auctioned'
        WHERE id = $1 AND user_id = $2 AND status = 'owned'
        RETURNING id`,
      [opts.userCardId, opts.userId],
    );
    if (flip.rowCount === 0) throw new AuctionError("CARD_NOT_AVAILABLE", "Card unavailable for auction");

    const ins = await client.query(
      `INSERT INTO auctions (seller_id, user_card_id, start_price_cents, end_time)
       VALUES ($1, $2, $3, NOW() + ($4 || ' seconds')::interval)
       RETURNING id, end_time`,
      [opts.userId, opts.userCardId, opts.startPriceCents, opts.durationSeconds],
    );
    return ins.rows[0];
  }, "READ COMMITTED");
}

/**
 * Place a bid. The bidder's funds are immediately moved from balance_available
 * to balance_held; the previous high bidder's funds are immediately released.
 *
 * Returns the new auction state on success.
 */
export async function placeBid(opts: { userId: string; auctionId: string; amountCents: number }) {
  // ── B3: Rate-limit before touching DB. Rapid-fire bots get bounced here.
  await checkBidRateLimits(opts.userId, opts.auctionId);

  const result = await withTxRetry(async (client) => {
    // 1. Read current state (no lock — we use optimistic concurrency).
    //    JOIN the card so we can fat-finger-check against current market price.
    const a = await client.query(
      `SELECT a.id, a.seller_id, a.current_bid_cents, a.current_bidder_id, a.end_time, a.status,
              a.version, a.snipe_window_seconds, a.snipe_extend_seconds, a.start_price_cents,
              a.min_increment_cents, a.sealed_phase_seconds,
              c.current_price_cents AS market_price_cents
         FROM auctions a
         JOIN user_cards uc ON uc.id = a.user_card_id
         JOIN cards c ON c.id = uc.card_id
        WHERE a.id = $1`,
      [opts.auctionId],
    );
    if (a.rows.length === 0) throw new AuctionError("AUCTION_NOT_FOUND", "Auction not found");
    const au = a.rows[0];
    if (au.status !== "live") throw new AuctionError("AUCTION_ENDED", "Auction is no longer live");
    if (new Date(au.end_time).getTime() <= Date.now()) {
      throw new AuctionError("AUCTION_ENDED", "Auction has ended");
    }
    if (au.seller_id === opts.userId) throw new AuctionError("OWN_AUCTION", "You cannot bid on your own auction");

    // ── B3: SELF-BID prevention. Cannot place a new bid if you ARE the high
    //    bidder — same rule eBay uses. Prevents shill self-bidding.
    if (au.current_bidder_id === opts.userId) {
      throw new IntegrityError("SELF_BID_HIGH", "You're already the high bidder");
    }

    // ── B3: FAT-FINGER guard. Hard-block bids more than 20× market.
    const fat = validateAmount(opts.amountCents, Number(au.market_price_cents || 0));
    if (fat.hardBlock) {
      // Record the rejected bid for audit.
      await client.query(
        `INSERT INTO bids (auction_id, bidder_id, amount_cents, status, rejected_reason)
         VALUES ($1,$2,$3,'rejected',$4)`,
        [opts.auctionId, opts.userId, opts.amountCents, fat.warn ?? "fat-finger"],
      );
      throw new IntegrityError("FAT_FINGER", fat.warn ?? "Bid blocked");
    }

    // 2. Validate the bid amount vs current high + increment.
    const currentBid = au.current_bid_cents ? Number(au.current_bid_cents) : null;
    const minNext =
      currentBid === null
        ? Number(au.start_price_cents)
        : Math.max(minNextBidCents(currentBid), currentBid + Number(au.min_increment_cents));
    if (opts.amountCents < minNext) {
      throw new AuctionError("BID_TOO_LOW", `Minimum bid is ${minNext} cents`);
    }

    // ── B3: SEALED PHASE detection — if inside the last N seconds, mark the
    //    bid as sealed. The pubsub message below masks the amount.
    const sealed = isSealedPhase(new Date(au.end_time), au.sealed_phase_seconds);

    // 3. Place HOLD on the new bidder's funds. Conditional UPDATE — bid fails
    //    cleanly if they don't have enough spendable.
    const hold = await client.query(
      `UPDATE users
          SET balance_available = balance_available - $2,
              balance_held      = balance_held      + $2
        WHERE id = $1 AND balance_available >= $2
        RETURNING balance_available, balance_held`,
      [opts.userId, opts.amountCents],
    );
    if (hold.rowCount === 0) throw new AuctionError("INSUFFICIENT_FUNDS", "Insufficient funds");

    // 4. RELEASE previous high bidder's hold (if any).
    if (au.current_bidder_id && currentBid !== null) {
      await client.query(
        `UPDATE users
            SET balance_available = balance_available + $2,
                balance_held      = balance_held      - $2
          WHERE id = $1`,
        [au.current_bidder_id, currentBid],
      );
      // Mark their bid row as outbid for history.
      await client.query(
        `UPDATE bids SET status = 'outbid'
          WHERE auction_id = $1 AND bidder_id = $2 AND status = 'active'`,
        [opts.auctionId, au.current_bidder_id],
      );
    }

    // 5. Determine new end_time (anti-snipe extension).
    const remainingMs = new Date(au.end_time).getTime() - Date.now();
    const extend = remainingMs <= au.snipe_window_seconds * 1000;

    // 6. The optimistic write: only succeeds if version is unchanged.
    //    GREATEST() ensures end_time is monotonic — never moves backward,
    //    even if the snipe-extend math somehow underestimated.
    const upd = await client.query(
      `UPDATE auctions
          SET current_bid_cents = $1,
              current_bidder_id = $2,
              end_time = CASE
                WHEN $5::boolean THEN GREATEST(end_time, NOW() + ($6 || ' seconds')::interval)
                ELSE end_time END,
              version = version + 1
        WHERE id = $3 AND version = $4 AND status = 'live'
        RETURNING current_bid_cents, current_bidder_id, end_time, version`,
      [opts.amountCents, opts.userId, opts.auctionId, au.version, extend, au.snipe_extend_seconds],
    );
    if (upd.rowCount === 0) {
      // Another bid won the race. Roll back via throw — withTxRetry will
      // retry on transient errors but VERSION_CONFLICT we want to surface.
      throw new AuctionError("VERSION_CONFLICT", "Bid conflicted with another — please retry");
    }

    // 7. Insert audit row, marked sealed=true if in sealed phase.
    const bid = await client.query(
      `INSERT INTO bids (auction_id, bidder_id, amount_cents, status, sealed)
       VALUES ($1, $2, $3, 'active', $4)
       RETURNING id, placed_at`,
      [opts.auctionId, opts.userId, opts.amountCents, sealed],
    );

    return {
      auction_id: opts.auctionId,
      current_bid_cents: opts.amountCents,
      end_time: upd.rows[0].end_time,
      version: upd.rows[0].version,
      extended: extend,
      sealed,
      _bid_id: bid.rows[0].id,
    };
  }, "READ COMMITTED");

  // Publish AFTER commit. If sealed, we mask amount and bidder so watchers
  // know "someone bid" without learning the amount — that's what kills the
  // sniping advantage.
  pub.publish(
    Channels.auction(opts.auctionId),
    JSON.stringify(
      result.sealed
        ? {
            type: "bid",
            auction_id: opts.auctionId,
            bid_id: result._bid_id,
            sealed: true,
            end_time: result.end_time,
            version: result.version,
            extended: result.extended,
          }
        : {
            type: "bid",
            auction_id: opts.auctionId,
            bid_id: result._bid_id,
            sealed: false,
            bidder_id: opts.userId,
            amount_cents: opts.amountCents,
            end_time: result.end_time,
            version: result.version,
            extended: result.extended,
          },
    ),
  ).catch(() => {});

  const { _bid_id, ...rest } = result;
  return rest;
}

/**
 * Settle an auction whose end_time has passed.
 * Idempotent: re-running on an already-settled auction is a no-op.
 *
 * If there were bids:
 *   - Final hold becomes a debit on the winner.
 *   - Seller receives (hammer - auction_fee).
 *   - Card transfers to winner.
 *
 * If there were NO bids:
 *   - Card returns to seller's inventory (status='owned').
 */
export async function settleAuction(opts: { auctionId: string }) {
  const result = await withTxRetry(async (client) => {
    // Try to atomically flip status. Idempotency handled by 'live' guard.
    const close = await client.query(
      `UPDATE auctions
          SET status = 'ended', closed_at = NOW(), version = version + 1
        WHERE id = $1 AND status = 'live' AND end_time <= NOW()
        RETURNING id, seller_id, user_card_id, current_bid_cents, current_bidder_id, start_price_cents`,
      [opts.auctionId],
    );
    if (close.rowCount === 0) return { settled: false as const, reason: "not-due-or-already-settled" };

    const au = close.rows[0];

    if (!au.current_bidder_id) {
      // No bids — return card to seller.
      await client.query(
        `UPDATE user_cards SET status = 'owned' WHERE id = $1 AND user_id = $2`,
        [au.user_card_id, au.seller_id],
      );
      return { settled: true as const, outcome: "no-bids" as const };
    }

    const hammer = Number(au.current_bid_cents);
    const [proceeds, fee] = applyFeeBps(hammer, FEES.AUCTION_BPS);

    // Convert winner's hold into a final debit. (held -= hammer; available
    // already debited at hold time.) No change to available.
    await client.query(
      `UPDATE users SET balance_held = balance_held - $2 WHERE id = $1`,
      [au.current_bidder_id, hammer],
    );

    // Seller receives proceeds.
    await client.query(
      `UPDATE users SET balance_available = balance_available + $2 WHERE id = $1`,
      [au.seller_id, proceeds],
    );

    // Card transfer.
    await client.query(
      `UPDATE user_cards
          SET user_id = $1, status = 'owned', source = 'auction',
              acquired_price_cents = $2, acquired_at = NOW()
        WHERE id = $3`,
      [au.current_bidder_id, hammer, au.user_card_id],
    );

    // Bid status updates — winning bid becomes 'won', everyone else's last bid was already 'outbid'.
    await client.query(
      `UPDATE bids SET status = 'won' WHERE auction_id = $1 AND bidder_id = $2 AND status = 'active'`,
      [opts.auctionId, au.current_bidder_id],
    );

    // Ledger.
    await client.query(
      `INSERT INTO ledger (user_id, type, amount_cents, related_kind, related_id) VALUES
         ($1, 'auction_win',      $2, 'auction', $5),
         ($3, 'auction_proceeds', $4, 'auction', $5),
         ($3, 'platform_fee',     $6, 'auction', $5)`,
      [au.current_bidder_id, -hammer, au.seller_id, proceeds, opts.auctionId, -fee],
    );
    await client.query(
      `INSERT INTO platform_revenue (source, amount_cents, related_kind, related_id)
       VALUES ('auction_fee', $1, 'auction', $2)`,
      [fee, opts.auctionId],
    );

    return {
      settled: true as const,
      outcome: "sold" as const,
      winner_id: au.current_bidder_id,
      hammer,
      proceeds,
      fee,
    };
  }, "READ COMMITTED");

  // Publish AFTER commit. Includes auction_id so subscribers know which.
  if (result.settled) {
    pub.publish(
      Channels.auction(opts.auctionId),
      JSON.stringify(
        result.outcome === "no-bids"
          ? { type: "settled", auction_id: opts.auctionId, outcome: "no-bids" }
          : {
              type: "settled",
              auction_id: opts.auctionId,
              outcome: "sold",
              winner_id: result.winner_id,
              hammer_cents: result.hammer,
              seller_proceeds_cents: result.proceeds,
              fee_cents: result.fee,
            },
      ),
    ).catch(() => {});
  }
  return result;
}

/** Auction state for the live room (read path — no transaction needed).
 *
 * Sealed-bid masking: while the auction is LIVE and inside the sealed phase,
 * we hide the amount + bidder_id of any sealed bid AND we hide the
 * current_bid_cents + current_bidder_id of the auction itself. Watchers see
 * only "sealed". Once the auction ends, full transparency is restored.
 */
export async function getAuctionState(auctionId: string) {
  const { rows } = await pool.query(
    `SELECT a.id, a.seller_id, a.current_bid_cents, a.current_bidder_id,
            a.start_price_cents, a.min_increment_cents, a.snipe_window_seconds,
            a.snipe_extend_seconds, a.sealed_phase_seconds,
            a.start_time, a.end_time, a.status, a.version,
            a.flagged_reason, a.flagged_severity,
            uc.id AS user_card_id,
            c.id AS card_id, c.tcg_id, c.name, c.set_name, c.rarity, c.image_url,
            c.current_price_cents AS market_price_cents
       FROM auctions a
       JOIN user_cards uc ON uc.id = a.user_card_id
       JOIN cards c ON c.id = uc.card_id
      WHERE a.id = $1`,
    [auctionId],
  );
  if (rows.length === 0) return null;
  const a = rows[0];

  const recent = await pool.query(
    `SELECT id, bidder_id, amount_cents, placed_at, status, sealed
       FROM bids WHERE auction_id = $1 ORDER BY placed_at DESC LIMIT 50`,
    [auctionId],
  );

  const remainingMs = new Date(a.end_time).getTime() - Date.now();
  const inSealedPhase = a.status === "live" && remainingMs > 0
    && remainingMs <= a.sealed_phase_seconds * 1000;

  if (inSealedPhase) {
    // Mask the current high bid + bidder. Mask sealed bid rows too.
    a.current_bid_cents = null;
    a.current_bidder_id = null;
    a.in_sealed_phase = true;
  } else {
    a.in_sealed_phase = false;
  }

  const bidsOut = recent.rows.map((b: any) =>
    b.sealed && inSealedPhase
      ? { ...b, bidder_id: null, amount_cents: null, masked: true }
      : { ...b, masked: false },
  );

  return { ...a, bids: bidsOut };
}

/** Worker loop: settle any expired auctions. Run on a 5-second tick. */
export async function settleExpiredAuctions() {
  const { rows } = await pool.query(
    `SELECT id FROM auctions WHERE status = 'live' AND end_time <= NOW() LIMIT 100`,
  );
  for (const r of rows) {
    try {
      await settleAuction({ auctionId: r.id });
    } catch (e) {
      console.error("settle failed", r.id, e);
    }
  }
}
