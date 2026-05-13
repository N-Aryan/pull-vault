import { pool } from "@/lib/db";
import { ok } from "@/lib/api-helpers";

/**
 * GET /api/admin/health
 *
 * Rolling margin per tier (last 24h), with deviation-from-target alerts,
 * plus core user-health metrics for the dashboard.
 */
export async function GET() {
  // Margin per tier — observed over the last 24h vs target.
  const margins = await pool.query(
    `WITH agg AS (
       SELECT t.id, t.slug, t.name, t.price_cents,
              COUNT(up.id)::int AS packs,
              COALESCE(SUM(up.price_paid),0)::bigint AS revenue,
              COALESCE(SUM((SELECT SUM((e->>'price_cents_at_pull')::bigint)
                              FROM jsonb_array_elements(up.contents_json) e)),0)::bigint AS payout
         FROM pack_tiers t
         LEFT JOIN user_packs up ON up.tier_id = t.id
              AND up.purchased_at > NOW() - INTERVAL '24 hours'
         GROUP BY t.id
     )
     SELECT id, slug, name, price_cents, packs, revenue, payout,
            CASE WHEN revenue > 0
                 THEN ((revenue - payout)::numeric / revenue * 10000)::int
                 ELSE NULL END AS realised_margin_bps
       FROM agg ORDER BY price_cents`,
  );

  const cfg = await pool.query(
    `SELECT target_margin_bps, min_margin_bps, last_rebalance_at FROM economics_config WHERE id = 1`,
  );
  const cfgRow = cfg.rows[0] ?? { target_margin_bps: 1500, min_margin_bps: 500 };

  // Alerts: any tier whose realised margin is below min_margin_bps OR
  // whose deviation from target exceeds 500 bps (5%).
  const alerts = margins.rows
    .map((m: any) => {
      if (m.realised_margin_bps == null || m.packs < 10) return null; // need sample size
      if (m.realised_margin_bps < cfgRow.min_margin_bps) {
        return { severity: "critical", tier: m.slug,
          message: `Margin ${(m.realised_margin_bps / 100).toFixed(2)}% below min ${(cfgRow.min_margin_bps / 100).toFixed(2)}%` };
      }
      const dev = Math.abs(m.realised_margin_bps - cfgRow.target_margin_bps);
      if (dev > 500) {
        return { severity: "warning", tier: m.slug,
          message: `Margin ${(m.realised_margin_bps / 100).toFixed(2)}% deviates ${(dev / 100).toFixed(2)}pp from target` };
      }
      return null;
    })
    .filter(Boolean);

  // Auction analytics (B3 surface)
  const auctions = await pool.query(
    `WITH stats AS (
       SELECT
         (SELECT COUNT(*) FROM auctions WHERE status = 'live')::int AS live_count,
         (SELECT COUNT(*) FROM auctions WHERE status = 'ended' AND closed_at > NOW() - INTERVAL '7 days')::int AS ended_7d,
         (SELECT AVG((SELECT COUNT(DISTINCT bidder_id) FROM bids WHERE auction_id = a.id))::float
            FROM auctions a WHERE a.status = 'ended' AND a.closed_at > NOW() - INTERVAL '7 days') AS avg_bidders,
         (SELECT COUNT(*) FROM bids WHERE sealed AND placed_at > NOW() - INTERVAL '7 days')::int AS sealed_bids,
         (SELECT COUNT(*) FROM bids WHERE rejected_reason IS NOT NULL AND placed_at > NOW() - INTERVAL '7 days')::int AS rejected_bids,
         (SELECT COUNT(*) FROM wash_trade_flags WHERE resolved_at IS NULL)::int AS open_flags
     ) SELECT * FROM stats`,
  );

  // User-health metrics
  const users = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM users)::int AS total_users,
       (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days')::int AS new_users_7d,
       (SELECT COUNT(DISTINCT user_id) FROM user_packs WHERE purchased_at > NOW() - INTERVAL '24 hours')::int AS dau_packs,
       (SELECT COUNT(DISTINCT bidder_id) FROM bids WHERE placed_at > NOW() - INTERVAL '24 hours')::int AS dau_bidders,
       (SELECT COUNT(*) FROM users WHERE flagged_at IS NOT NULL)::int AS flagged_count`,
  );

  return ok({
    margins: margins.rows,
    target_margin_bps: cfgRow.target_margin_bps,
    min_margin_bps: cfgRow.min_margin_bps,
    last_rebalance_at: cfgRow.last_rebalance_at,
    alerts,
    auctions: auctions.rows[0],
    users: users.rows[0],
  });
}
