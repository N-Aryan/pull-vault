import { NextRequest } from "next/server";
import { cancelListing, MarketError } from "@/lib/market-engine";
import { ok, fail, requireUser } from "@/lib/api-helpers";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { error, userId } = await requireUser(req);
  if (error) return error;
  try {
    const out = await cancelListing({ userId, listingId: params.id });
    return ok(out);
  } catch (e) {
    if (e instanceof MarketError) return fail(e.message, 400);
    return fail("internal error", 500);
  }
}
