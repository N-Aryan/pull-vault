import { NextRequest } from "next/server";
import { revealPack } from "@/lib/pack-engine";
import { ok, fail, requireUser } from "@/lib/api-helpers";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { error, userId } = await requireUser(req);
  if (error) return error;
  try {
    const out = await revealPack({ userId, userPackId: params.id });
    return ok(out);
  } catch (e: any) {
    return fail(e.message ?? "reveal failed", 400);
  }
}
