import { NextRequest } from "next/server";
import { getAuctionState } from "@/lib/auction-engine";
import { ok, fail } from "@/lib/api-helpers";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const state = await getAuctionState(params.id);
  if (!state) return fail("not found", 404);
  return ok(state);
}
