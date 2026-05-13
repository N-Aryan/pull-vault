import { NextRequest } from "next/server";
import { pool } from "@/lib/db";
import { ok, fail } from "@/lib/api-helpers";

/**
 * GET /api/packs/:id/verify
 *
 * Returns the cryptographic proof for a pack — the data the verification
 * page replays in the browser. Public: anyone can fetch any pack's proof.
 * server_seed is only included if the pack has been revealed.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { rows } = await pool.query(
    `SELECT up.id, up.user_id, up.tier_id, up.purchased_at, up.revealed_at,
            up.contents_json, up.server_seed_hash, up.server_seed, up.client_seed,
            up.nonce, up.weights_snapshot, up.card_pool_hash,
            t.slug AS tier_slug, t.cards_per_pack
       FROM user_packs up JOIN pack_tiers t ON t.id = up.tier_id
      WHERE up.id = $1`,
    [params.id],
  );
  if (rows.length === 0) return fail("pack not found", 404);
  const p = rows[0];

  // Pre-reveal: hide server_seed. Post-reveal: expose it.
  const exposeSeed = !!p.revealed_at;

  // We expose the FULL card pool order at purchase time too — the verifier
  // needs the exact ID list per rarity to recompute card indices. We rebuild
  // it deterministically here from the catalog as it exists NOW, then
  // verify the hash matches up.card_pool_hash. If the catalog changed, the
  // hash mismatch is the user's red flag.
  const pool_rows = await pool.query(
    `SELECT id, rarity FROM cards ORDER BY id`,
  );
  const ids_by_rarity: Record<string, string[]> = {};
  for (const r of pool_rows.rows) (ids_by_rarity[r.rarity] ??= []).push(r.id);

  return ok({
    pack_id: p.id,
    tier_slug: p.tier_slug,
    cards_per_pack: Number(p.cards_per_pack),
    purchased_at: p.purchased_at,
    revealed_at: p.revealed_at,
    commit: {
      server_seed_hash: p.server_seed_hash,
      server_seed: exposeSeed ? p.server_seed : null,
      client_seed: p.client_seed,
      nonce: p.nonce ? Number(p.nonce) : null,
      weights_snapshot: p.weights_snapshot,
      card_pool_hash: p.card_pool_hash,
    },
    contents: p.contents_json,
    current_pool: { ids_by_rarity },
  });
}
