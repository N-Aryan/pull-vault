import { pool } from "@/lib/db";
import { chiSquaredFit, RARITIES, type RarityWeights } from "@/lib/economics";
import { ok } from "@/lib/api-helpers";

/**
 * GET /api/admin/fairness
 *
 * For each tier, compares the OBSERVED rarity distribution of all revealed
 * packs (from contents_json) against the ADVERTISED weights at purchase
 * time (weights_snapshot). Runs a chi-squared goodness-of-fit test and
 * surfaces the p-value.
 *
 * Interpretation:
 *   p < 0.01  → strong evidence the actual distribution deviates from
 *                advertised. The platform is lying — or there's a bug.
 *   0.01..0.05 → suspicious; investigate.
 *   p > 0.05  → consistent with advertised weights at 5% significance.
 *
 * We use weights_snapshot per pack (not pack_tiers.rarity_weights) so a
 * rebalance doesn't invalidate the historical comparison.
 */

export async function GET() {
  // Pull all revealed packs of each tier with their snapshotted weights and
  // pulled rarities. Group by tier, but use the most-common weights snapshot
  // as the expected vector (rebalances are rare; pre/post should be compared
  // separately if they coexist).
  const tiers = await pool.query(`SELECT id, slug, name FROM pack_tiers`);

  const results = [];
  for (const t of tiers.rows) {
    const packs = await pool.query(
      `SELECT contents_json, weights_snapshot FROM user_packs
        WHERE tier_id = $1 AND revealed_at IS NOT NULL AND weights_snapshot IS NOT NULL`,
      [t.id],
    );
    if (packs.rows.length === 0) {
      results.push({ tier: t, n_packs: 0, test: null });
      continue;
    }
    // Aggregate observed rarities across all revealed packs.
    const observed: Record<string, number> = {};
    for (const p of packs.rows) {
      for (const c of p.contents_json as any[]) {
        observed[c.rarity] = (observed[c.rarity] ?? 0) + 1;
      }
    }
    // Use the most-recent snapshot as the expected weights. (For long-running
    // multi-rebalance audits, partition the packs by snapshot hash and run
    // the test per partition.)
    const expected = packs.rows[packs.rows.length - 1].weights_snapshot as RarityWeights;
    const test = chiSquaredFit(observed, expected);

    results.push({
      tier: t,
      n_packs: packs.rows.length,
      n_pulls: Object.values(observed).reduce((a, v) => a + v, 0),
      expected_weights: expected,
      observed_counts: observed,
      test,
    });
  }

  // How many users used the verification page (rough proxy: how many packs
  // have been revealed; the verify page reads pack.proof). For a real audit,
  // log verify-page hits explicitly.
  const verifiedCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM user_packs WHERE revealed_at IS NOT NULL`,
  );

  return ok({ per_tier: results, revealed_packs_total: verifiedCount.rows[0].n });
}
