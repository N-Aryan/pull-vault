import { NextRequest } from "next/server";
import { buyListing, MarketError } from "@/lib/market-engine";
import { ok, fail, requireUser } from "@/lib/api-helpers";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { error, userId } = await requireUser(req);
  if (error) return error;
  try {
    const out = await buyListing({ userId, listingId: params.id });
    return ok(out);
  } catch (e) {
    if (e instanceof MarketError) {
      const status =
        e.code === "ALREADY_SOLD" ? 409 :
        e.code === "INSUFFICIENT_FUNDS" ? 402 :
        e.code === "CANT_BUY_OWN_LISTING" ? 400 : 404;
      return fail(e.message, status);
    }
    console.error(e);
    return fail("internal error", 500);
  }
}
