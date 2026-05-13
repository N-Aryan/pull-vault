import { NextRequest } from "next/server";
import { z } from "zod";
import { pool } from "@/lib/db";
import { simulate, computePackStats, RARITIES, type PoolStats, type RarityWeights } from "@/lib/economics";
import { ok, fail } from "@/lib/api-helpers";

/**
 * POST /api/admin/economics/simulate
 *
 * Body: { tier_slug: string, count?: number, weights?: RarityWeights }
 *
 * Runs 10,000 (configurable) pack openings using either the persisted tier
 * weights or a candidate vector supplied in the body. Returns the empirical
 * distribution, observed margin, win rate, and a histogram.
 *
 * This is the "what-if" endpoint used by the admin dashboard before
 * applying a rebalance.
 */

const Body = z.object({
  tier_slug: z.string().min(1),
  count: z.number().int().min(100).max(100_000).optional(),
  weights: z.record(z.number()).optional(),
});

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("invalid input", 400);

  const tierQ = await pool.query(
    `SELECT id, slug, price_cents, cards_per_pack, rarity_weights
       FROM pack_tiers WHERE slug = $1`,
    [parsed.data.tier_slug],
  );
  if (tierQ.rows.length === 0) return fail("tier not found", 404);
  const tier = tierQ.rows[0];

  // Pull rarity stats from the catalog (means + stddevs)
  const statsQ = await pool.query(
    `SELECT rarity,
            AVG(current_price_cents)::bigint AS mean_cents,
            STDDEV_POP(current_price_cents)::bigint AS stddev_cents,
            COUNT(*)::int AS count
       FROM cards
      GROUP BY rarity`,
  );
  const stats: PoolStats = {};
  for (const r of statsQ.rows) {
    stats[r.rarity as keyof PoolStats] = {
      mean_cents: Number(r.mean_cents) || 0,
      stddev_cents: Number(r.stddev_cents) || 0,
      count: Number(r.count) || 0,
    };
  }

  const weights = (parsed.data.weights ?? tier.rarity_weights) as RarityWeights;
  const count = parsed.data.count ?? 10_000;

  const sim = simulate(
    weights,
    stats,
    { price_cents: Number(tier.price_cents), cards_per_pack: Number(tier.cards_per_pack) },
    count,
  );

  const analytical = computePackStats(weights, stats, Number(tier.cards_per_pack));

  return ok({
    tier: { slug: tier.slug, price_cents: Number(tier.price_cents), cards_per_pack: Number(tier.cards_per_pack) },
    weights_used: weights,
    rarity_stats: stats,
    analytical: {
      ev_cents: analytical.ev_cents,
      std_cents: analytical.std_cents,
    },
    simulation: sim,
  });
}
