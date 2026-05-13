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
import { detectWashTrades } from "../src/lib/auction-integrity";
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

async function tickWashTrades() {
  try {
    const r = await detectWashTrades();
    if (r.flagged > 0) console.log(`[wash] ${r.flagged} new flags`);
  } catch (e) {
    console.error("[wash]", e);
  }
}

async function tickMarginSnapshot() {
  // Roll an hourly snapshot per tier into margin_snapshots, used by the
  // economic-health dashboard. Window = last 60 minutes.
  try {
    const cfg = await pool.query(`SELECT target_margin_bps FROM economics_config WHERE id = 1`);
    const target = Number(cfg.rows[0]?.target_margin_bps ?? 1500);

    await pool.query(
      `INSERT INTO margin_snapshots
         (tier_id, window_start, window_end, packs_sold, total_revenue_cents,
          total_payout_cents, realised_margin_bps, target_margin_bps)
       SELECT
         t.id,
         NOW() - INTERVAL '1 hour',
         NOW(),
         COUNT(up.id)::int,
         COALESCE(SUM(up.price_paid),0)::bigint,
         COALESCE(SUM((SELECT SUM((e->>'price_cents_at_pull')::bigint)
                        FROM jsonb_array_elements(up.contents_json) e)),0)::bigint,
         CASE WHEN COALESCE(SUM(up.price_paid),0) > 0
              THEN (SUM(up.price_paid) - COALESCE(SUM((SELECT SUM((e->>'price_cents_at_pull')::bigint)
                                                      FROM jsonb_array_elements(up.contents_json) e)),0))::numeric
                   / SUM(up.price_paid) * 10000
              ELSE NULL END,
         $1
       FROM pack_tiers t
       LEFT JOIN user_packs up ON up.tier_id = t.id
            AND up.purchased_at >= NOW() - INTERVAL '1 hour'
       GROUP BY t.id`,
      [target],
    );
  } catch (e) {
    console.error("[margin]", e);
  }
}

setInterval(tickAuctions, 3_000);
setInterval(tickPrices, 30_000);
setInterval(tickDrops, 10_000);
setInterval(tickWashTrades, 5 * 60_000);   // every 5 minutes
setInterval(tickMarginSnapshot, 60 * 60_000); // hourly

// Run once on boot too
tickDrops();
tickPrices();
tickMarginSnapshot();
