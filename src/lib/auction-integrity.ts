import { pool } from "@/lib/db";
import { check, RULES, logViolation } from "@/lib/rate-limit";

/**
 * Auction Integrity Layer
 * ───────────────────────
 *
 * SEALED-BID PHASE (anti-snipe v2)
 *   The last `sealed_phase_seconds` (default 60s) of every auction become a
 *   "blind" phase:
 *     - Bids are still accepted.
 *     - Their amounts are hidden from other watchers in the room.
 *     - The bid history shows "Sealed bid" until the auction closes.
 *   Why this beats sniping bots:
 *     - A snipe-bot's playbook is "watch the high bid, fire +$1 in the last
 *       100ms". If the bot can't see the high bid, it can't undercut.
 *     - The bot must commit to its maximum amount blindly. So must humans.
 *       The information asymmetry that favoured the bot is gone.
 *   Composition with the Part A anti-snipe timer:
 *     - The sealed phase begins inside the anti-snipe window. If a sealed bid
 *       extends the timer, the new sealed phase starts again from the new
 *       end_time. The two mechanisms reinforce each other.
 *
 * BID VALIDATION
 *   - fat-finger: warn if amount > 5x market price; HARD BLOCK if > 20x.
 *   - rapid-fire: max 3 bids per 10s per (user, auction). Enforced via RL.
 *   - self-bidding: a user cannot place a bid if they are already the high
 *     bidder. This prevents the "shill-bid yourself for price discovery"
 *     pattern. It does NOT prevent legitimate above-yourself bumps because
 *     why would you outbid yourself? (Same rule eBay uses.)
 *
 * WASH-TRADE DETECTION
 *   We periodically scan for:
 *     - >3 trades between the same two accounts in 7 days
 *     - auctions closing < 50% of market value with only 1 bidder
 *     - cyclic transfers (A→B→A within 30 days)
 *   Matches insert into wash_trade_flags. We DO NOT auto-reverse the trade.
 *   Admin decides.
 */

export class IntegrityError extends Error {
  constructor(
    public code:
      | "FAT_FINGER"
      | "RAPID_FIRE"
      | "SELF_BID_HIGH"
      | "AMOUNT_INVALID",
    msg: string,
  ) { super(msg); }
}

/** Soft-validate a bid amount. Returns warning text (or null) and a hard-block flag. */
export function validateAmount(amountCents: number, marketCents: number): { hardBlock: boolean; warn: string | null } {
  if (amountCents <= 0) return { hardBlock: true, warn: "Bid must be positive" };
  if (marketCents <= 0) return { hardBlock: false, warn: null }; // no reference
  const ratio = amountCents / marketCents;
  if (ratio > 20) return { hardBlock: true, warn: `Bid is ${ratio.toFixed(1)}× market price — fat-finger guard` };
  if (ratio > 5) return { hardBlock: false, warn: `Bid is ${ratio.toFixed(1)}× market price (warning)` };
  return { hardBlock: false, warn: null };
}

/** Rate-limit per-auction bid frequency (also caught by RULES.bidPerAuction). */
export async function checkBidRateLimits(userId: string, auctionId: string) {
  const perUser = await check(userId, "bid", RULES.bidPerUser);
  if (!perUser.allowed) {
    await logViolation({ userId, endpoint: "auctions/bid", outcome: "blocked", detail: `user-rate retry=${perUser.retry_at_ms}` });
    throw new IntegrityError("RAPID_FIRE", "Slow down — too many bids");
  }
  const perAuc = await check(`${userId}:${auctionId}`, "bid_auc", RULES.bidPerAuction);
  if (!perAuc.allowed) {
    await logViolation({ userId, endpoint: "auctions/bid", outcome: "blocked", detail: `auction-rate retry=${perAuc.retry_at_ms}` });
    throw new IntegrityError("RAPID_FIRE", "Too many bids on this auction — wait a few seconds");
  }
}

/**
 * Returns true if we are currently INSIDE the sealed phase (last N seconds).
 * Caller (placeBid) marks the bid row as sealed=true and the pubsub message
 * sent to watchers will mask the amount.
 */
export function isSealedPhase(endTime: Date, sealedPhaseSeconds: number): boolean {
  const remainingMs = endTime.getTime() - Date.now();
  return remainingMs > 0 && remainingMs <= sealedPhaseSeconds * 1000;
}

// ────────────────────────────────────────────────────────────────────
// Wash-trade detection — runs on a worker tick (see workers.ts).
// We isolate the heuristics from any UI/state side-effects: this module
// ONLY inserts into wash_trade_flags. An admin reviews.
// ────────────────────────────────────────────────────────────────────

export async function detectWashTrades(): Promise<{ flagged: number }> {
  let flagged = 0;

  // Heuristic 1: same (seller, buyer) pair traded > 3 times in 7 days.
  const dup = await pool.query(
    `WITH trades AS (
       SELECT seller_id AS user_a, uc.user_id AS user_b
         FROM listings l
         JOIN user_cards uc ON uc.id = l.user_card_id
        WHERE l.status = 'sold' AND l.closed_at > NOW() - INTERVAL '7 days'
       UNION ALL
       SELECT seller_id AS user_a, current_bidder_id AS user_b
         FROM auctions
        WHERE status = 'ended' AND closed_at > NOW() - INTERVAL '7 days'
          AND current_bidder_id IS NOT NULL
     )
     SELECT user_a, user_b, COUNT(*) AS n
       FROM trades
      WHERE user_a IS NOT NULL AND user_b IS NOT NULL AND user_a <> user_b
      GROUP BY user_a, user_b HAVING COUNT(*) > 3`,
  );
  for (const r of dup.rows) {
    const ins = await pool.query(
      `INSERT INTO wash_trade_flags (related_kind, related_id, reason, severity, user_a, user_b)
       SELECT 'pair', gen_random_uuid(), $3, 3, $1, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM wash_trade_flags
          WHERE user_a = $1 AND user_b = $2 AND resolved_at IS NULL
            AND flagged_at > NOW() - INTERVAL '7 days')
       RETURNING id`,
      [r.user_a, r.user_b, `Same pair traded ${r.n} times in 7 days`],
    );
    if (ins.rowCount && ins.rowCount > 0) flagged++;
  }

  // Heuristic 2: auction closed below 50% of market price with only 1 bidder.
  const lowballed = await pool.query(
    `SELECT a.id, a.seller_id, a.current_bidder_id, a.current_bid_cents,
            c.current_price_cents AS market_cents
       FROM auctions a
       JOIN user_cards uc ON uc.id = a.user_card_id
       JOIN cards c ON c.id = uc.card_id
       JOIN (SELECT auction_id, COUNT(DISTINCT bidder_id) AS bidders FROM bids GROUP BY auction_id) b
            ON b.auction_id = a.id
      WHERE a.status = 'ended'
        AND a.closed_at > NOW() - INTERVAL '24 hours'
        AND a.current_bid_cents IS NOT NULL
        AND c.current_price_cents > 0
        AND a.current_bid_cents::numeric / c.current_price_cents < 0.5
        AND b.bidders = 1`,
  );
  for (const r of lowballed.rows) {
    const ins = await pool.query(
      `INSERT INTO wash_trade_flags (related_kind, related_id, reason, severity, user_a, user_b)
       VALUES ('auction', $1, $2, 4, $3, $4)
       ON CONFLICT DO NOTHING RETURNING id`,
      [r.id, `Closed at ${((r.current_bid_cents / r.market_cents) * 100).toFixed(0)}% of market with 1 bidder`, r.seller_id, r.current_bidder_id],
    );
    if (ins.rowCount && ins.rowCount > 0) flagged++;
  }

  // Heuristic 3: cyclic transfers A→B→A within 30 days.
  // (A card goes from A to B, then back to A.)
  const cycles = await pool.query(
    `WITH transfers AS (
       SELECT uc.id AS card_id, l.seller_id AS from_user, uc.user_id AS to_user, l.closed_at
         FROM listings l JOIN user_cards uc ON uc.id = l.user_card_id
        WHERE l.status = 'sold' AND l.closed_at > NOW() - INTERVAL '30 days'
       UNION ALL
       SELECT uc.id AS card_id, a.seller_id AS from_user, a.current_bidder_id AS to_user, a.closed_at
         FROM auctions a JOIN user_cards uc ON uc.id = a.user_card_id
        WHERE a.status = 'ended' AND a.closed_at > NOW() - INTERVAL '30 days'
          AND a.current_bidder_id IS NOT NULL
     )
     SELECT t1.card_id, t1.from_user AS user_a, t1.to_user AS user_b
       FROM transfers t1 JOIN transfers t2
            ON t1.card_id = t2.card_id
        WHERE t1.from_user = t2.to_user AND t1.to_user = t2.from_user
          AND t1.closed_at < t2.closed_at
        GROUP BY t1.card_id, t1.from_user, t1.to_user`,
  );
  for (const r of cycles.rows) {
    const ins = await pool.query(
      `INSERT INTO wash_trade_flags (related_kind, related_id, reason, severity, user_a, user_b)
       SELECT 'cycle', $1, $2, 5, $3, $4
       WHERE NOT EXISTS (
         SELECT 1 FROM wash_trade_flags
          WHERE related_kind = 'cycle' AND user_a = $3 AND user_b = $4 AND resolved_at IS NULL
       ) RETURNING id`,
      [r.card_id, "Cyclic transfer A→B→A within 30 days", r.user_a, r.user_b],
    );
    if (ins.rowCount && ins.rowCount > 0) flagged++;
  }

  return { flagged };
}
