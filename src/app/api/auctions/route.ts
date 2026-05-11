import { NextRequest } from "next/server";
import { z } from "zod";
import { pool } from "@/lib/db";
import { createAuction, AuctionError } from "@/lib/auction-engine";
import { ok, fail, requireUser } from "@/lib/api-helpers";

export async function GET() {
  const { rows } = await pool.query(
    `SELECT a.id, a.start_price_cents, a.current_bid_cents, a.current_bidder_id,
            a.start_time, a.end_time, a.status, a.version, a.seller_id,
            uc.id AS user_card_id,
            c.id AS card_id, c.name, c.set_name, c.rarity, c.image_url, c.current_price_cents
       FROM auctions a
       JOIN user_cards uc ON uc.id = a.user_card_id
       JOIN cards c ON c.id = uc.card_id
      WHERE a.status = 'live'
      ORDER BY a.end_time ASC`,
  );
  return ok(rows);
}

const Body = z.object({
  user_card_id: z.string().uuid(),
  start_price_cents: z.number().int().positive(),
  duration_seconds: z.number().int().min(60).max(7 * 24 * 3600),
});

export async function POST(req: NextRequest) {
  const { error, userId } = await requireUser(req);
  if (error) return error;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("invalid input", 400);
  try {
    const out = await createAuction({
      userId,
      userCardId: parsed.data.user_card_id,
      startPriceCents: parsed.data.start_price_cents,
      durationSeconds: parsed.data.duration_seconds,
    });
    return ok(out);
  } catch (e) {
    if (e instanceof AuctionError) return fail(e.message, 400);
    return fail("internal error", 500);
  }
}
