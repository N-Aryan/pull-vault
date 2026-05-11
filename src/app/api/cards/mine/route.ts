import { NextRequest } from "next/server";
import { pool } from "@/lib/db";
import { ok, requireUser } from "@/lib/api-helpers";

export async function GET(req: NextRequest) {
  const { error, userId } = await requireUser(req);
  if (error) return error;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const sort = url.searchParams.get("sort") ?? "recent";
  const sortSql =
    sort === "value_desc" ? "c.current_price_cents DESC" :
    sort === "value_asc" ? "c.current_price_cents ASC" :
    sort === "rarity" ? `CASE c.rarity
      WHEN 'secret' THEN 1 WHEN 'ultra' THEN 2 WHEN 'holo' THEN 3
      WHEN 'rare' THEN 4 WHEN 'uncommon' THEN 5 ELSE 6 END ASC` :
    "uc.acquired_at DESC";

  const params: any[] = [userId];
  let where = `uc.user_id = $1`;
  if (status) { params.push(status); where += ` AND uc.status = $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT uc.id AS user_card_id, uc.acquired_price_cents, uc.acquired_at, uc.status, uc.source,
            c.id AS card_id, c.tcg_id, c.name, c.set_name, c.rarity, c.image_url,
            c.current_price_cents,
            (c.current_price_cents - uc.acquired_price_cents) AS pl_cents
       FROM user_cards uc JOIN cards c ON c.id = uc.card_id
      WHERE ${where}
      ORDER BY ${sortSql}`,
    params,
  );

  // Portfolio totals
  const totals = await pool.query(
    `SELECT
       COUNT(*)::int AS total_cards,
       COALESCE(SUM(c.current_price_cents),0)::bigint AS total_value_cents,
       COALESCE(SUM(uc.acquired_price_cents),0)::bigint AS total_cost_cents
     FROM user_cards uc JOIN cards c ON c.id = uc.card_id
     WHERE uc.user_id = $1 AND uc.status IN ('owned','listed','auctioned')`,
    [userId],
  );

  return ok({ cards: rows, totals: totals.rows[0] });
}
