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
        DROP TABLE IF EXISTS idempotency_keys, platform_revenue, ledger,
          bids, auctions, listings, user_cards, user_packs, pack_drops,
          pack_tiers, card_price_history, cards, users CASCADE;
      `);
    }

    const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
    await pool.query(sql);
    console.log("Schema applied");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
