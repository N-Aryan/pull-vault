import { pool, withTx } from "@/lib/db";
import { computeTierEV } from "@/lib/pack-engine";
import { ok } from "@/lib/api-helpers";

export async function GET() {
  // Revenue rollup
  const rev = await pool.query(
    `SELECT source,
            COALESCE(SUM(amount_cents),0)::bigint AS total_cents,
            COUNT(*)::int AS events
       FROM platform_revenue
       GROUP BY source`,
  );
  const total = rev.rows.reduce((a: number, r: any) => a + Number(r.total_cents), 0);

  // Per-tier EV — compute fresh from current card prices
  const tierIds = await pool.query(`SELECT id, name, slug, price_cents FROM pack_tiers ORDER BY price_cents ASC`);
  const tiers = await withTx(async (client) => {
    const out = [];
    for (const t of tierIds.rows) {
      const ev = await computeTierEV(client, t.id);
      out.push({ tier: t, ev });
    }
    return out;
  });

  // User stats
  const users = await pool.query(`SELECT
      COUNT(*)::int AS total_users,
      COALESCE(SUM(balance_available),0)::bigint AS total_balance_cents,
      COALESCE(SUM(balance_held),0)::bigint AS total_held_cents
    FROM users`);

  // Activity counters
  const activity = await pool.query(`SELECT
      (SELECT COUNT(*) FROM user_packs)::int AS packs_sold,
      (SELECT COUNT(*) FROM listings WHERE status='sold')::int AS trades_completed,
      (SELECT COUNT(*) FROM auctions WHERE status='ended')::int AS auctions_ended,
      (SELECT COUNT(*) FROM user_cards)::int AS total_cards_owned`);

  return ok({
    revenue: { breakdown: rev.rows, total_cents: total },
    tiers,
    users: users.rows[0],
    activity: activity.rows[0],
  });
}
