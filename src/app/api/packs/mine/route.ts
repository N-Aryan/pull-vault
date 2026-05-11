import { NextRequest } from "next/server";
import { pool } from "@/lib/db";
import { ok, requireUser } from "@/lib/api-helpers";

export async function GET(req: NextRequest) {
  const { error, userId } = await requireUser(req);
  if (error) return error;
  const { rows } = await pool.query(
    `SELECT up.id, up.purchased_at, up.revealed_at, up.price_paid, up.contents_json,
            t.name AS tier_name, t.slug AS tier_slug
       FROM user_packs up JOIN pack_tiers t ON t.id = up.tier_id
      WHERE up.user_id = $1
      ORDER BY up.purchased_at DESC`,
    [userId],
  );
  return ok(rows);
}
