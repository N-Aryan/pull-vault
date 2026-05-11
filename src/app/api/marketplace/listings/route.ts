import { NextRequest } from "next/server";
import { z } from "zod";
import { listActiveListings, listCard, MarketError } from "@/lib/market-engine";
import { ok, fail, requireUser } from "@/lib/api-helpers";

export async function GET() {
  const rows = await listActiveListings({ limit: 100 });
  return ok(rows);
}

const Body = z.object({ user_card_id: z.string().uuid(), price_cents: z.number().int().positive() });

export async function POST(req: NextRequest) {
  const { error, userId } = await requireUser(req);
  if (error) return error;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("invalid input", 400);
  try {
    const out = await listCard({ userId, userCardId: parsed.data.user_card_id, priceCents: parsed.data.price_cents });
    return ok(out);
  } catch (e) {
    if (e instanceof MarketError) return fail(e.message, 400);
    return fail("internal error", 500);
  }
}
