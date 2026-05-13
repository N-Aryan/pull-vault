import { NextRequest } from "next/server";
import { z } from "zod";
import { buyPack, PackError } from "@/lib/pack-engine";
import { ok, fail, requireUser } from "@/lib/api-helpers";
import { checkPackPurchase, logViolation } from "@/lib/rate-limit";
import { fairnessDelay, recordPurchaseAttempt } from "@/lib/fairness-queue";
import { pool } from "@/lib/db";

const Body = z.object({
  drop_id: z.string().uuid(),
  client_seed: z.string().max(64).optional(),
});

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function POST(req: NextRequest) {
  const { error, userId } = await requireUser(req);
  if (error) return error;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("invalid input", 400);

  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") || "unknown";

  // 1. RATE LIMIT — checks user, IP, daily budget. Sliding-window log.
  const rl = await checkPackPurchase(userId, ip);
  if (!rl.allowed) {
    await logViolation({
      userId, ip, endpoint: "packs/buy", outcome: "blocked",
      detail: `rule=${rl.rule} count=${rl.count} retry_at=${rl.retry_at_ms}`,
    });
    return fail(`rate limited (${rl.rule}) — retry after ${new Date(rl.retry_at_ms).toISOString()}`, 429);
  }

  // 2. BEHAVIOURAL SCORING — does not block, but flags suspicious patterns.
  const behaviour = await recordPurchaseAttempt({ userId, ip, userAgent: ua });
  if (behaviour.bot_score >= 0.7) {
    await pool
      .query(
        `UPDATE users
            SET bot_score = GREATEST(bot_score, $2),
                flagged_reason = $3,
                flagged_at = COALESCE(flagged_at, NOW())
          WHERE id = $1`,
        [userId, behaviour.bot_score, behaviour.signals.join("; ")],
      )
      .catch(() => {});
    await logViolation({
      userId, ip, endpoint: "packs/buy", outcome: "flagged",
      detail: `score=${behaviour.bot_score.toFixed(2)} ${behaviour.signals.join(", ")}`,
    });
    // We do NOT block flagged users immediately. They can still buy, but the
    // dashboard surfaces them and an admin decides. This avoids false-positives
    // taking down real users (the brief calls this out).
  }

  // 3. FAIRNESS DELAY — randomly stagger 0..500ms so fastest-client doesn't win.
  await fairnessDelay(userId, parsed.data.drop_id);

  // 4. The actual purchase (concurrency-safe path from Part A).
  try {
    const out = await buyPack({
      userId,
      dropId: parsed.data.drop_id,
      clientSeed: parsed.data.client_seed,
    });
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
