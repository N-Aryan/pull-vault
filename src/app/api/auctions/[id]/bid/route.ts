import { NextRequest } from "next/server";
import { z } from "zod";
import { placeBid, AuctionError } from "@/lib/auction-engine";
import { ok, fail, requireUser } from "@/lib/api-helpers";

const Body = z.object({ amount_cents: z.number().int().positive() });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { error, userId } = await requireUser(req);
  if (error) return error;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("invalid input", 400);
  try {
    const out = await placeBid({ userId, auctionId: params.id, amountCents: parsed.data.amount_cents });
    return ok(out);
  } catch (e) {
    if (e instanceof AuctionError) {
      const status =
        e.code === "BID_TOO_LOW" ? 400 :
        e.code === "INSUFFICIENT_FUNDS" ? 402 :
        e.code === "AUCTION_ENDED" ? 410 :
        e.code === "VERSION_CONFLICT" ? 409 : 400;
      return fail(e.message, status);
    }
    console.error(e);
    return fail("internal error", 500);
  }
}
