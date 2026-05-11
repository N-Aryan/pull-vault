/**
 * Background workers, run as a single subprocess by server.js.
 *
 *  • auction-closer  : every 3s, settle expired auctions (idempotent)
 *  • price-ticker    : every 30s, jitter card prices ±2% and broadcast on
 *                      Redis pub/sub channel "prices:tick"
 *  • drop-launcher   : every 10s, flip `scheduled` drops whose drop_time has
 *                      passed to `live`, broadcast a "live" event on the
 *                      drop's channel
 */

import "./load-env";
import { pool } from "../src/lib/db";
import { settleExpiredAuctions } from "../src/lib/auction-engine";
import { pub, Channels } from "../src/lib/redis";
import Decimal from "decimal.js";

console.log("[workers] starting");

async function tickAuctions() {
  try {
    await settleExpiredAuctions();
  } catch (e) {
    console.error("[auctions]", e);
  }
}

async function tickPrices() {
  // Move every card's price by a small random amount and write history.
  // This is a stand-in for a real TCGPlayer market poll. In production we'd
  // pull the actual API every N minutes and only walk the diff.
  try {
    const { rows } = await pool.query(`SELECT id, current_price_cents FROM cards`);
    if (rows.length === 0) return;
    const updates: { id: string; price: number }[] = [];
    for (const r of rows) {
      const cur = Number(r.current_price_cents);
      // Mean-reverting random walk: 96% revert toward "fair" value (just hold),
      // 4% drift up to ±2%. Keeps the demo alive without prices exploding.
      if (Math.random() > 0.04) continue;
      const move = (Math.random() - 0.5) * 0.04;
      const next = new Decimal(cur).mul(1 + move).round().toNumber();
      updates.push({ id: r.id, price: Math.max(1, next) });
    }
    if (updates.length === 0) return;
    // Batch the updates in one transaction.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const u of updates) {
        await client.query(
          `UPDATE cards SET current_price_cents = $2, last_price_update = NOW() WHERE id = $1`,
          [u.id, u.price],
        );
        await client.query(
          `INSERT INTO card_price_history (card_id, price_cents) VALUES ($1, $2)`,
          [u.id, u.price],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    pub.publish(Channels.prices, JSON.stringify({ updated: updates.length, t: Date.now() })).catch(() => {});
    console.log(`[prices] ${updates.length} cards moved`);
  } catch (e) {
    console.error("[prices]", e);
  }
}

async function tickDrops() {
  try {
    const { rows } = await pool.query(
      `UPDATE pack_drops SET status = 'live'
        WHERE status = 'scheduled' AND drop_time <= NOW()
        RETURNING id`,
    );
    for (const r of rows) {
      pub.publish(Channels.drop(r.id), JSON.stringify({ type: "live" })).catch(() => {});
    }
  } catch (e) {
    console.error("[drops]", e);
  }
}

setInterval(tickAuctions, 3_000);
setInterval(tickPrices, 30_000);
setInterval(tickDrops, 10_000);

// Run once on boot too
tickDrops();
tickPrices();
