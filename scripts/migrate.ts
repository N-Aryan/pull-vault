import "./load-env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set — copy .env.example to .env");

  const reset = process.argv.includes("--reset");
  const pool = new Pool({ connectionString: url });

  try {
    if (reset) {
      console.log("Dropping all tables…");
      await pool.query(`
        DROP TABLE IF EXISTS margin_snapshots, wash_trade_flags, rate_limit_events,
          economics_config, idempotency_keys, platform_revenue, ledger,
          bids, auctions, listings, user_cards, user_packs, pack_drops,
          pack_tiers, card_price_history, cards, users CASCADE;
      `);
    }

    // Apply Part A schema first, then Part B additive migrations.
    await pool.query(readFileSync(join(__dirname, "schema.sql"), "utf8"));
    console.log("Part A schema applied");
    await pool.query(readFileSync(join(__dirname, "schema-b.sql"), "utf8"));
    console.log("Part B schema applied");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
