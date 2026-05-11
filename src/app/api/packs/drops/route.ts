import { pool } from "@/lib/db";
import { ok } from "@/lib/api-helpers";

export async function GET() {
  const { rows } = await pool.query(
    `SELECT d.id, d.total_inventory, d.sold_count, d.drop_time, d.status,
            t.id AS tier_id, t.slug, t.name, t.description, t.price_cents, t.cards_per_pack
       FROM pack_drops d JOIN pack_tiers t ON t.id = d.tier_id
      WHERE d.status IN ('scheduled','live','sold_out')
      ORDER BY d.drop_time ASC`,
  );
  return ok(rows);
}
