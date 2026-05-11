import { withTxRetry, pool } from "@/lib/db";
import { applyFeeBps, FEES } from "@/lib/money";

/**
 * Marketplace Engine
 * ──────────────────
 * Fixed-price peer-to-peer trading. The card moves AND money moves in a
 * single DB transaction — never one without the other.
 *
 * Concurrency contracts (the "what must not break" list from the brief):
 *
 *   1. A listed card cannot be sold to two buyers.
 *      → Listing is closed by a conditional UPDATE on status='active'.
 *        Only one transaction's UPDATE can succeed; the rest see rowCount=0
 *        and throw ALREADY_SOLD. Same row-locking trick as the pack drop.
 *
 *   2. Trade is atomic — money + card move together or neither.
 *      → All UPDATEs in one transaction. No commit until everything succeeds.
 *
 *   3. Seller can't sell a card already in an active auction.
 *      → Enforced by the partial unique index uq_auction_active_card AND by
 *        checking user_cards.status before creating the listing.
 *
 *   4. Buyer can't buy with funds held in auction bids.
 *      → balance_available is the spendable balance; auction holds live in
 *        balance_held. The conditional UPDATE only debits balance_available.
 */

export class MarketError extends Error {
  constructor(
    public code:
      | "LISTING_NOT_FOUND"
      | "ALREADY_SOLD"
      | "INSUFFICIENT_FUNDS"
      | "CANT_BUY_OWN_LISTING"
      | "CARD_NOT_OWNED"
      | "CARD_NOT_AVAILABLE",
    msg: string,
  ) {
    super(msg);
  }
}

export async function listCard(opts: { userId: string; userCardId: string; priceCents: number }) {
  if (opts.priceCents <= 0) throw new MarketError("CARD_NOT_AVAILABLE", "Price must be positive");

  return withTxRetry(async (client) => {
    // Conditionally flip the user_card to 'listed' — only succeeds if currently
    // 'owned' AND owned by this user. This is the one and only point at which
    // the listing-vs-auction race is resolved.
    const flip = await client.query(
      `UPDATE user_cards
          SET status = 'listed'
        WHERE id = $1 AND user_id = $2 AND status = 'owned'
        RETURNING id, card_id`,
      [opts.userCardId, opts.userId],
    );
    if (flip.rowCount === 0) throw new MarketError("CARD_NOT_AVAILABLE", "Card unavailable for listing");

    const ins = await client.query(
      `INSERT INTO listings (seller_id, user_card_id, price_cents)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [opts.userId, opts.userCardId, opts.priceCents],
    );
    return ins.rows[0];
  }, "READ COMMITTED");
}

export async function cancelListing(opts: { userId: string; listingId: string }) {
  return withTxRetry(async (client) => {
    const close = await client.query(
      `UPDATE listings
          SET status = 'cancelled', closed_at = NOW()
        WHERE id = $1 AND seller_id = $2 AND status = 'active'
        RETURNING user_card_id`,
      [opts.listingId, opts.userId],
    );
    if (close.rowCount === 0) throw new MarketError("LISTING_NOT_FOUND", "Listing not found or not active");
    await client.query(
      `UPDATE user_cards SET status = 'owned' WHERE id = $1 AND user_id = $2`,
      [close.rows[0].user_card_id, opts.userId],
    );
    return { ok: true };
  }, "READ COMMITTED");
}

/**
 * Buy a listed card. The critical path.
 *
 * Lock ordering: we always lock the listing first, then the buyer's user row,
 * then the seller's. Consistent ordering across all paths prevents deadlock.
 * (The pack-engine debit also touches users, but it never touches listings,
 * so they don't conflict on lock order.)
 */
export async function buyListing(opts: { userId: string; listingId: string }) {
  return withTxRetry(async (client) => {
    // 1. Close the listing atomically. Conditional UPDATE on status='active'
    //    is THE serialization point — exactly one buyer's UPDATE will succeed.
    const close = await client.query(
      `UPDATE listings
          SET status = 'sold', closed_at = NOW()
        WHERE id = $1 AND status = 'active'
        RETURNING id, seller_id, user_card_id, price_cents`,
      [opts.listingId],
    );
    if (close.rowCount === 0) throw new MarketError("ALREADY_SOLD", "Sorry, this listing is no longer available");

    const { seller_id, user_card_id, price_cents } = close.rows[0];
    if (seller_id === opts.userId) {
      // Caller bought their own listing — refund-by-rollback by throwing.
      throw new MarketError("CANT_BUY_OWN_LISTING", "You cannot buy your own listing");
    }

    // 2. Debit buyer atomically.
    const debit = await client.query(
      `UPDATE users
          SET balance_available = balance_available - $2
        WHERE id = $1 AND balance_available >= $2
        RETURNING balance_available`,
      [opts.userId, price_cents],
    );
    if (debit.rowCount === 0) throw new MarketError("INSUFFICIENT_FUNDS", "Insufficient funds");

    // 3. Calculate platform fee (taken from seller's proceeds).
    const [sellerProceeds, fee] = applyFeeBps(Number(price_cents), FEES.TRADE_BPS);

    // 4. Credit seller, transfer card.
    await client.query(
      `UPDATE users SET balance_available = balance_available + $2 WHERE id = $1`,
      [seller_id, sellerProceeds],
    );
    await client.query(
      `UPDATE user_cards SET user_id = $1, status = 'owned',
          acquired_price_cents = $2, acquired_at = NOW(), source = 'trade'
        WHERE id = $3 AND user_id = $4`,
      [opts.userId, price_cents, user_card_id, seller_id],
    );

    // 5. Ledger entries.
    await client.query(
      `INSERT INTO ledger (user_id, type, amount_cents, related_kind, related_id) VALUES
         ($1, 'trade_buy',  $2, 'listing', $5),
         ($3, 'trade_sell', $4, 'listing', $5),
         ($3, 'platform_fee', $6, 'listing', $5)`,
      [opts.userId, -Number(price_cents), seller_id, sellerProceeds, opts.listingId, -fee],
    );
    await client.query(
      `INSERT INTO platform_revenue (source, amount_cents, related_kind, related_id)
       VALUES ('trade_fee', $1, 'listing', $2)`,
      [fee, opts.listingId],
    );

    return {
      listing_id: opts.listingId,
      price_cents: Number(price_cents),
      fee_cents: fee,
      seller_proceeds_cents: sellerProceeds,
    };
  }, "READ COMMITTED");
}

export async function listActiveListings(opts: { limit?: number; offset?: number } = {}) {
  const { rows } = await pool.query(
    `SELECT l.id, l.price_cents, l.created_at, l.seller_id,
            uc.id AS user_card_id,
            c.id AS card_id, c.tcg_id, c.name, c.set_name, c.rarity, c.image_url, c.current_price_cents
       FROM listings l
       JOIN user_cards uc ON uc.id = l.user_card_id
       JOIN cards c ON c.id = uc.card_id
      WHERE l.status = 'active'
      ORDER BY l.created_at DESC
      LIMIT $1 OFFSET $2`,
    [opts.limit ?? 50, opts.offset ?? 0],
  );
  return rows;
}
