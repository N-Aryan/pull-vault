import { NextRequest } from "next/server";
import { z } from "zod";
import { buyPack, PackError } from "@/lib/pack-engine";
import { ok, fail, requireUser } from "@/lib/api-helpers";

const Body = z.object({ drop_id: z.string().uuid() });

export async function POST(req: NextRequest) {
  const { error, userId } = await requireUser(req);
  if (error) return error;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("invalid input", 400);

  try {
    const out = await buyPack({ userId, dropId: parsed.data.drop_id });
    return ok(out);
  } catch (e) {
    if (e instanceof PackError) {
      const status =
        e.code === "SOLD_OUT" ? 409 :
        e.code === "INSUFFICIENT_FUNDS" ? 402 :
        e.code === "DROP_NOT_LIVE" ? 425 : 404;
      return fail(e.message, status);
    }
    console.error(e);
    return fail("internal error", 500);
  }
}
