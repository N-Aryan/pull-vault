import Decimal from "decimal.js";
import { withTxRetry } from "@/lib/db";
import { pub, Channels } from "@/lib/redis";
import { PoolClient } from "pg";

/**
 * Pack Engine
 * ───────────
 * The hardest part of the trial: N users click Buy on M packs at the same
 * millisecond. Exactly M succeed, exactly N-M get a clean "Sold Out".
 *
 * Strategy:
 *   1. Conditional UPDATE on pack_drops with WHERE sold_count < total_inventory
 *      — Postgres atomically returns affected-row-count of 0 or 1.
 *   2. Conditional UPDATE on users with WHERE balance_available >= price.
 *   3. Both inside a single transaction. If either returns 0 rows, ROLLBACK.
 *
 * This avoids SELECT-then-UPDATE (TOCTOU) bugs. The DB does the check + write
 * atomically. We don't even need explicit row locks — the conditional UPDATE
 * is itself a row-level lock for the duration of the statement, and Postgres
 * serializes conflicting writers automatically.
 *
 * The CHECK constraint `sold_count <= total_inventory` is a defence in depth:
 * even if app logic has a bug, the DB will reject the overselling write.
 *
 * Pack contents are determined SERVER-SIDE at purchase time. Storing them in
 * contents_json on user_packs prevents the user from refreshing to re-roll.
 */

type RarityWeights = Record<string, number>;

export type PackContents = Array<{
  card_id: string;
  tcg_id: string;
  name: string;
  set_name: string;
  rarity: string;
  image_url: string;
  price_cents_at_pull: number;
}>;

export class PackError extends Error {
  constructor(public code: "SOLD_OUT" | "INSUFFICIENT_FUNDS" | "DROP_NOT_LIVE" | "DROP_NOT_FOUND", msg: string) {
    super(msg);
  }
}

/** Weighted random pick over a rarity-weights map. Decimal-safe. */
function pickRarity(weights: RarityWeights): string {
  const keys = Object.keys(weights);
  const total = keys.reduce((a, k) => a + weights[k], 0);
  let r = Math.random() * total;
  for (const k of keys) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

/**
 * Roll pack contents from the catalog. Picks a rarity per slot, then picks a
 * random card from that rarity bucket (via TABLESAMPLE / ORDER BY random()).
 *
 * For pack tiers above the "starter" tier we guarantee at least one rare-or-
 * better slot — this is a common feel-good pull system in the real industry
 * and keeps the EV math from being feast-or-famine.
 */
async function rollPack(
  client: PoolClient,
  weights: RarityWeights,
  slots: number,
  guaranteedRareOrBetter: boolean,
): Promise<PackContents> {
  const rarities = Array.from({ length: slots }, () => pickRarity(weights));
  if (guaranteedRareOrBetter) {
    const isRareOrBetter = (r: string) => r === "rare" || r === "holo" || r === "ultra" || r === "secret";
    if (!rarities.some(isRareOrBetter)) {
      // Upgrade the last slot from common/uncommon to rare. Cheapest "guarantee".
      rarities[rarities.length - 1] = "rare";
    }
  }
  const out: PackContents = [];
  for (const rarity of rarities) {
    // ORDER BY random() is fine at our card-table scale (< 50k rows). For a
    // real prod system at 1M+ rows we'd use TABLESAMPLE SYSTEM_ROWS or pre-
    // shuffled materialised views.
    const { rows } = await client.query(
      `SELECT id, tcg_id, name, set_name, rarity, image_url, current_price_cents
         FROM cards WHERE rarity = $1 ORDER BY random() LIMIT 1`,
      [rarity],
    );
    if (rows.length === 0) {
      // No card in that rarity bucket — degrade to common so the pack always
      // has the right number of cards.
      const fb = await client.query(
        `SELECT id, tcg_id, name, set_name, rarity, image_url, current_price_cents
           FROM cards WHERE rarity = 'common' ORDER BY random() LIMIT 1`,
      );
      if (fb.rows.length === 0) throw new Error("Card catalog is empty — run npm run db:seed");
      const c = fb.rows[0];
      out.push({
        card_id: c.id, tcg_id: c.tcg_id, name: c.name, set_name: c.set_name,
        rarity: c.rarity, image_url: c.image_url, price_cents_at_pull: Number(c.current_price_cents),
      });
    } else {
      const c = rows[0];
      out.push({
        card_id: c.id, tcg_id: c.tcg_id, name: c.name, set_name: c.set_name,
        rarity: c.rarity, image_url: c.image_url, price_cents_at_pull: Number(c.current_price_cents),
      });
    }
  }
  return out;
}

/**
 * Purchase a pack from a live drop.
 * Returns the user_pack id (with contents) on success. Throws PackError otherwise.
 *
 * Concurrency contract:
 *   - sold_count never exceeds total_inventory (DB CHECK + conditional UPDATE)
 *   - users.balance_available never goes negative (CHECK constraint)
 *   - Exactly one of: (success path executes both UPDATEs, INSERT, ledger row)
 *     or (rollback, no rows changed at all)
 */
export async function buyPack(opts: { userId: string; dropId: string }) {
  const result = await withTxRetry(async (client) => {
    // 1. Fetch the drop + tier in one shot, without any lock — we only need it
    //    for the price + weights. The conditional UPDATE below is the actual
    //    serialization point.
    const dropQ = await client.query(
      `SELECT d.id, d.status, d.drop_time, d.total_inventory, d.sold_count,
              t.id AS tier_id, t.price_cents, t.cards_per_pack, t.rarity_weights, t.slug
         FROM pack_drops d JOIN pack_tiers t ON t.id = d.tier_id
         WHERE d.id = $1`,
      [opts.dropId],
    );
    if (dropQ.rows.length === 0) throw new PackError("DROP_NOT_FOUND", "Drop not found");
    const drop = dropQ.rows[0];
    if (drop.status !== "live" && drop.status !== "scheduled") {
      throw new PackError("DROP_NOT_LIVE", "This drop is not available");
    }
    if (new Date(drop.drop_time).getTime() > Date.now()) {
      throw new PackError("DROP_NOT_LIVE", "Drop hasn't started yet");
    }

    // 2. Decrement inventory atomically — only succeeds if sold_count < total.
    const decQ = await client.query(
      `UPDATE pack_drops
          SET sold_count = sold_count + 1,
              status = CASE WHEN sold_count + 1 >= total_inventory THEN 'sold_out' ELSE 'live' END
        WHERE id = $1 AND sold_count < total_inventory
        RETURNING sold_count, total_inventory, status`,
      [opts.dropId],
    );
    if (decQ.rowCount === 0) throw new PackError("SOLD_OUT", "Sold out");
    const { sold_count, total_inventory, status: newStatus } = decQ.rows[0];

    // 3. Debit balance atomically — only succeeds if balance_available >= price.
    const debitQ = await client.query(
      `UPDATE users
          SET balance_available = balance_available - $2
        WHERE id = $1 AND balance_available >= $2
        RETURNING balance_available`,
      [opts.userId, drop.price_cents],
    );
    if (debitQ.rowCount === 0) throw new PackError("INSUFFICIENT_FUNDS", "Insufficient funds");

    // 4. Roll contents server-side — the user can never influence the result.
    const contents = await rollPack(
      client,
      drop.rarity_weights,
      drop.cards_per_pack,
      drop.slug !== "starter", // starter has no guarantee; everything else does
    );

    // 5. Insert the user_pack record.
    const upQ = await client.query(
      `INSERT INTO user_packs (user_id, drop_id, tier_id, price_paid, contents_json)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, purchased_at`,
      [opts.userId, opts.dropId, drop.tier_id, drop.price_cents, JSON.stringify(contents)],
    );

    // 6. Ledger entry + platform revenue (margin = price - sum of card values)
    const evCents = contents.reduce((a, c) => a + c.price_cents_at_pull, 0);
    const margin = Number(drop.price_cents) - evCents;
    await client.query(
      `INSERT INTO ledger (user_id, type, amount_cents, related_kind, related_id)
       VALUES ($1, 'pack_purchase', $2, 'pack', $3)`,
      [opts.userId, -drop.price_cents, upQ.rows[0].id],
    );
    await client.query(
      `INSERT INTO platform_revenue (source, amount_cents, related_kind, related_id)
       VALUES ('pack_margin', $1, 'pack', $2)`,
      [margin, upQ.rows[0].id],
    );

    return {
      user_pack_id: upQ.rows[0].id,
      purchased_at: upQ.rows[0].purchased_at,
      contents,
      price_paid: Number(drop.price_cents),
      ev_cents: evCents,
      margin_cents: margin,
      // for the post-commit publish (pulled out of the closure)
      _drop_id: opts.dropId,
      _sold_count: sold_count,
      _total_inventory: total_inventory,
      _new_status: newStatus,
    };
  }, "READ COMMITTED"); // conditional UPDATEs are sufficient — no need for SERIALIZABLE

  // Publish AFTER commit. If withTxRetry retried, the closure above ran more
  // than once but the publish only fires for the successful run. If commit
  // failed, we throw and never reach this line. Including drop_id in payload
  // so the WebSocket client can route updates to the right drop card.
  pub.publish(
    Channels.drop(result._drop_id),
    JSON.stringify({
      type: "sold",
      drop_id: result._drop_id,
      sold_count: result._sold_count,
      total_inventory: result._total_inventory,
      status: result._new_status,
    }),
  ).catch(() => {});

  // Strip the underscore-prefixed internal fields from the API response.
  const { _drop_id, _sold_count, _total_inventory, _new_status, ...rest } = result;
  return rest;
}

/**
 * Reveal flips revealed_at AND materialises the cards into user_cards inventory.
 * The contents are already determined and stored at purchase time. This call is
 * idempotent: revealing a second time just returns the same contents.
 */
export async function revealPack(opts: { userId: string; userPackId: string }) {
  return withTxRetry(async (client) => {
    const r = await client.query(
      `SELECT id, user_id, contents_json, revealed_at FROM user_packs
        WHERE id = $1 AND user_id = $2`,
      [opts.userPackId, opts.userId],
    );
    if (r.rows.length === 0) throw new Error("Pack not found");
    const pack = r.rows[0];
    if (pack.revealed_at) return { id: pack.id, contents: pack.contents_json, alreadyRevealed: true };

    // Mark revealed
    await client.query(`UPDATE user_packs SET revealed_at = NOW() WHERE id = $1`, [pack.id]);

    // Materialise each card into user_cards (so trade/auction can reference it)
    const contents = pack.contents_json as PackContents;
    for (const c of contents) {
      await client.query(
        `INSERT INTO user_cards (user_id, card_id, acquired_price_cents, source, status)
         VALUES ($1, $2, $3, 'pack', 'owned')`,
        [opts.userId, c.card_id, c.price_cents_at_pull],
      );
    }
    return { id: pack.id, contents, alreadyRevealed: false };
  }, "READ COMMITTED");
}

/** Compute expected value for a pack tier given current card prices.
 * Used by the admin economics dashboard. */
export async function computeTierEV(client: PoolClient, tierId: string) {
  const t = await client.query(
    `SELECT price_cents, cards_per_pack, rarity_weights FROM pack_tiers WHERE id = $1`,
    [tierId],
  );
  if (t.rows.length === 0) return null;
  const tier = t.rows[0];
  const weights = tier.rarity_weights as RarityWeights;

  // Average price per rarity bucket from the catalog
  const avg = await client.query(
    `SELECT rarity, AVG(current_price_cents)::bigint AS avg_cents, COUNT(*) AS n
       FROM cards GROUP BY rarity`,
  );
  const avgByRarity: Record<string, number> = {};
  for (const r of avg.rows) avgByRarity[r.rarity] = Number(r.avg_cents);

  let evPerSlot = new Decimal(0);
  let totalWeight = 0;
  for (const k of Object.keys(weights)) totalWeight += weights[k];
  for (const k of Object.keys(weights)) {
    const p = new Decimal(weights[k]).div(totalWeight);
    evPerSlot = evPerSlot.add(p.mul(avgByRarity[k] ?? 0));
  }
  const evPerPack = evPerSlot.mul(tier.cards_per_pack).round().toNumber();
  const margin = Number(tier.price_cents) - evPerPack;
  const marginPct = new Decimal(margin).div(tier.price_cents).mul(100).toFixed(2);
  return {
    price_cents: Number(tier.price_cents),
    ev_cents: evPerPack,
    margin_cents: margin,
    margin_pct: Number(marginPct),
  };
}
