import Decimal from "decimal.js";
import { withTxRetry } from "@/lib/db";
import { pub, Channels } from "@/lib/redis";
import { PoolClient } from "pg";
import {
  generateServerSeed,
  rollSlot,
  pickWeighted,
  cardPoolHash,
} from "@/lib/provably-fair";

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

/**
 * Roll pack contents from a SNAPSHOT of the card pool using a deterministic
 * HMAC-driven stream. The card pool is hashed (card_pool_hash) so that the
 * exact set of cards eligible for selection at this purchase moment is
 * provably committed — the server can't "swap in" a worse card later.
 *
 * Returns contents + the pool snapshot hash (for storage in user_packs).
 */
async function rollPackProvablyFair(
  client: PoolClient,
  weights: RarityWeights,
  slots: number,
  guaranteedRareOrBetter: boolean,
  seed: { server_seed: string; client_seed: string; nonce: number },
): Promise<{ contents: PackContents; pool_hash: string; pool: Record<string, any[]> }> {
  // 1. Read the entire pool of cards keyed by rarity, deterministically
  //    ordered by id so the same pool yields the same indices on replay.
  const all = await client.query(
    `SELECT id, tcg_id, name, set_name, rarity, image_url, current_price_cents
       FROM cards ORDER BY id`,
  );
  if (all.rows.length === 0) throw new Error("Card catalog is empty — run npm run db:seed");
  const byRarity: Record<string, any[]> = {};
  for (const r of all.rows) (byRarity[r.rarity] ??= []).push(r);

  const idsByRarity: Record<string, string[]> = {};
  for (const k of Object.keys(byRarity)) idsByRarity[k] = byRarity[k].map((c) => c.id);
  const pool_hash = cardPoolHash(idsByRarity);

  // 2. Roll each slot using the HMAC stream.
  const rarityKeys = Object.keys(weights);
  const out: PackContents = [];
  const rarities: string[] = [];
  for (let s = 0; s < slots; s++) {
    const { u_rarity, u_card } = rollSlot(seed.server_seed, seed.client_seed, seed.nonce, s);
    let chosen = pickWeighted(weights as any, rarityKeys as any, u_rarity);
    // If the chosen rarity bucket is empty, fall through to "common".
    if (!byRarity[chosen] || byRarity[chosen].length === 0) chosen = "common";
    rarities.push(chosen);
    const bucket = byRarity[chosen] ?? byRarity["common"];
    const idx = Math.min(bucket.length - 1, Math.floor(u_card * bucket.length));
    const c = bucket[idx];
    out.push({
      card_id: c.id, tcg_id: c.tcg_id, name: c.name, set_name: c.set_name,
      rarity: c.rarity, image_url: c.image_url, price_cents_at_pull: Number(c.current_price_cents),
    });
  }

  // 3. Guarantee logic — uses an EXTRA deterministic roll so we can replay it.
  //    If guarantee is required and no slot rolled rare-or-better, we use
  //    HMAC slot index = slots (one past the last real slot) to pick which
  //    slot to upgrade. This is fully deterministic and verifiable.
  if (guaranteedRareOrBetter) {
    const isRareOrBetter = (r: string) => r === "rare" || r === "holo" || r === "ultra" || r === "secret";
    if (!out.some((c) => isRareOrBetter(c.rarity))) {
      const { u_rarity: u_pick, u_card } = rollSlot(seed.server_seed, seed.client_seed, seed.nonce, slots);
      const upgradeIdx = Math.min(slots - 1, Math.floor(u_pick * slots));
      const bucket = byRarity["rare"] ?? byRarity["common"];
      const cardIdx = Math.min(bucket.length - 1, Math.floor(u_card * bucket.length));
      const c = bucket[cardIdx];
      out[upgradeIdx] = {
        card_id: c.id, tcg_id: c.tcg_id, name: c.name, set_name: c.set_name,
        rarity: c.rarity, image_url: c.image_url, price_cents_at_pull: Number(c.current_price_cents),
      };
    }
  }
  return { contents: out, pool_hash, pool: byRarity };
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
export async function buyPack(opts: {
  userId: string;
  dropId: string;
  /** Optional client-supplied entropy. If omitted we generate one. */
  clientSeed?: string;
}) {
  // Generate the server seed OUTSIDE the transaction so retries (40001) don't
  // generate a new commit each time. The commit is locked the moment the buy
  // succeeds — that's the cryptographic guarantee.
  const { server_seed, commit_hash } = generateServerSeed();
  const clientSeed = opts.clientSeed && opts.clientSeed.length > 0
    ? opts.clientSeed.slice(0, 64)
    : require("node:crypto").randomBytes(16).toString("hex");

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

    // 3. Debit balance atomically AND bump the user's pack nonce (one stmt).
    //    The nonce is part of the HMAC input so each pack a user buys has a
    //    unique deterministic stream — protects against replay/copy attacks.
    const debitQ = await client.query(
      `UPDATE users
          SET balance_available = balance_available - $2,
              pack_nonce = pack_nonce + 1,
              last_request_ip = COALESCE($3, last_request_ip),
              last_user_agent = COALESCE($4, last_user_agent)
        WHERE id = $1 AND balance_available >= $2
        RETURNING balance_available, pack_nonce`,
      [opts.userId, drop.price_cents, null, null],
    );
    if (debitQ.rowCount === 0) throw new PackError("INSUFFICIENT_FUNDS", "Insufficient funds");
    const nonce = Number(debitQ.rows[0].pack_nonce);

    // 4. Roll contents using the provably-fair HMAC stream. The weights
    //    snapshot is the EXACT vector used — recorded so the user can replay.
    const rolled = await rollPackProvablyFair(
      client,
      drop.rarity_weights,
      drop.cards_per_pack,
      drop.slug !== "starter",
      { server_seed, client_seed: clientSeed, nonce },
    );
    const contents = rolled.contents;

    // 5. Insert the user_pack record with the commit hash, weights snapshot
    //    and pool hash. server_seed is stored too — it stays SECRET until
    //    reveal time (the reveal endpoint is what exposes it).
    const upQ = await client.query(
      `INSERT INTO user_packs (
         user_id, drop_id, tier_id, price_paid, contents_json,
         server_seed_hash, server_seed, client_seed, nonce,
         weights_snapshot, card_pool_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, purchased_at, server_seed_hash`,
      [
        opts.userId, opts.dropId, drop.tier_id, drop.price_cents, JSON.stringify(contents),
        commit_hash, server_seed, clientSeed, nonce,
        JSON.stringify(drop.rarity_weights), rolled.pool_hash,
      ],
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
      // Provably-fair: only the commit is public at this stage.
      commit_hash,
      client_seed: clientSeed,
      nonce,
      // for the post-commit publish
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
      `SELECT id, user_id, contents_json, revealed_at,
              server_seed, server_seed_hash, client_seed, nonce,
              weights_snapshot, card_pool_hash
         FROM user_packs WHERE id = $1 AND user_id = $2`,
      [opts.userPackId, opts.userId],
    );
    if (r.rows.length === 0) throw new Error("Pack not found");
    const pack = r.rows[0];

    // Provably-fair: revealing exposes server_seed so the user can verify.
    const proof = {
      server_seed: pack.server_seed,
      server_seed_hash: pack.server_seed_hash,
      client_seed: pack.client_seed,
      nonce: pack.nonce ? Number(pack.nonce) : null,
      weights_snapshot: pack.weights_snapshot,
      card_pool_hash: pack.card_pool_hash,
    };

    if (pack.revealed_at) {
      return { id: pack.id, contents: pack.contents_json, alreadyRevealed: true, proof };
    }

    await client.query(`UPDATE user_packs SET revealed_at = NOW() WHERE id = $1`, [pack.id]);

    const contents = pack.contents_json as PackContents;
    for (const c of contents) {
      await client.query(
        `INSERT INTO user_cards (user_id, card_id, acquired_price_cents, source, status)
         VALUES ($1, $2, $3, 'pack', 'owned')`,
        [opts.userId, c.card_id, c.price_cents_at_pull],
      );
    }
    return { id: pack.id, contents, alreadyRevealed: false, proof };
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
