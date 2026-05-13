import { NextRequest } from "next/server";
import { z } from "zod";
import { pool } from "@/lib/db";
import { solveWeights, type PoolStats, type SolveConfig } from "@/lib/economics";
import { ok, fail } from "@/lib/api-helpers";

/**
 * POST /api/admin/economics/rebalance
 *
 * For each tier, recompute rarity weights against the current card pool to
 * hit the configured target margin while keeping the win-rate floor.
 *
 * Body: { dry_run?: boolean } — when true, return the proposed weights
 * without persisting. UI shows this first; admin confirms to apply.
 */
const Body = z.object({ dry_run: z.boolean().optional() });

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("invalid input", 400);
  const dryRun = parsed.data.dry_run ?? false;

  const cfgRow = await pool.query(`SELECT * FROM economics_config WHERE id = 1`);
  const cfgDb = cfgRow.rows[0];
  const cfg: SolveConfig = {
    target_margin_bps:  Number(cfgDb.target_margin_bps),
    min_margin_bps:     Number(cfgDb.min_margin_bps),
    win_rate_floor_bps: Number(cfgDb.win_rate_floor_bps),
  };

  // Rarity stats from the catalog (same query as /simulate)
  const statsQ = await pool.query(
    `SELECT rarity,
            AVG(current_price_cents)::bigint AS mean_cents,
            STDDEV_POP(current_price_cents)::bigint AS stddev_cents,
            COUNT(*)::int AS count
       FROM cards GROUP BY rarity`,
  );
  const stats: PoolStats = {};
  for (const r of statsQ.rows) {
    stats[r.rarity as keyof PoolStats] = {
      mean_cents: Number(r.mean_cents) || 0,
      stddev_cents: Number(r.stddev_cents) || 0,
      count: Number(r.count) || 0,
    };
  }

  const tiers = await pool.query(
    `SELECT id, slug, price_cents, cards_per_pack, rarity_weights FROM pack_tiers ORDER BY price_cents`,
  );

  const results = [];
  for (const t of tiers.rows) {
    const tierParams = {
      price_cents: Number(t.price_cents),
      cards_per_pack: Number(t.cards_per_pack),
      guarantee_rare_or_better: t.slug !== "starter",
      allowed_rarities: t.slug === "starter"
        ? (["common", "uncommon", "rare", "holo"] as any)
        : undefined,
    };
    const solved = solveWeights(tierParams, stats, cfg);
    results.push({ tier_slug: t.slug, tier_id: t.id, before: t.rarity_weights, after: solved });

    if (!dryRun && solved.reason === "converged") {
      await pool.query(
        `UPDATE pack_tiers SET rarity_weights = $2 WHERE id = $1`,
        [t.id, JSON.stringify(solved.weights)],
      );
    }
  }

  if (!dryRun) {
    await pool.query(`UPDATE economics_config SET last_rebalance_at = NOW() WHERE id = 1`);
  }

  return ok({ dry_run: dryRun, target_cfg: cfg, results });
}
