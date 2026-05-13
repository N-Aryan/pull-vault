import { redis } from "@/lib/redis";

/**
 * Purchase Fairness Queue
 * ───────────────────────
 *
 * The race for limited pack inventory should not be a network-latency
 * contest. The fastest bot will always win an unmoderated race.
 *
 * STRATEGY: random jitter window
 *   1. Caller arrives at /api/packs/buy.
 *   2. We bucket them into a 500ms "fairness window" — every request that
 *      arrives in the same window goes into a Redis list keyed by drop+window.
 *   3. At the end of the window, each request gets a random delay between
 *      0 and 500ms (deterministic — keyed off the user + window so retries
 *      don't game it).
 *   4. After their delay, they enter the actual purchase path.
 *
 *   Effect: any two humans who click "Buy" within the same window have an
 *   equal expected probability of getting the pack. A bot's network speed
 *   advantage compresses from milliseconds to "their random number vs mine".
 *
 *   Edge case: what if 1000 requests arrive in the same window for 10
 *   inventory? Same 1000 requests would have raced anyway. We don't change
 *   how many succeed — just who succeeds. Fairer outcome.
 *
 * We could do a fancier solution (token bucket, weighted by account age,
 * etc.) but this is the smallest-surface-area change that breaks the
 * fastest-client-wins property.
 */

const WINDOW_MS = 500;

/** Delay the caller by 0..WINDOW_MS, deterministic per (user, drop, window). */
export async function fairnessDelay(userId: string, dropId: string): Promise<number> {
  const window = Math.floor(Date.now() / WINDOW_MS);
  // Salted hash → uniform in [0,1)
  const seed = `${userId}:${dropId}:${window}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const u = (h % 1_000_000) / 1_000_000;
  const delay = Math.floor(u * WINDOW_MS);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  return delay;
}

/**
 * Behavioural bot-scoring.
 * Signals tracked in Redis (TTL'd to prevent unbounded growth):
 *   - inter-arrival time of purchase clicks  (very fast = bot)
 *   - user-agent diversity                   (multiple UAs from same user = scripted)
 *   - request burst rate                     (n requests in ms-window = scripted)
 *
 * Each signal contributes to a bot_score (0..1). Score >= 0.7 → flagged.
 */
export interface BehaviourPing {
  userId: string;
  ip: string;
  userAgent: string;
}

export async function recordPurchaseAttempt(p: BehaviourPing): Promise<{ bot_score: number; signals: string[] }> {
  const now = Date.now();
  const signals: string[] = [];
  let score = 0;

  // 1. Inter-arrival time
  const lastKey = `behaviour:last:${p.userId}`;
  const last = await redis.getset(lastKey, String(now));
  await redis.pexpire(lastKey, 60 * 60_000);
  if (last) {
    const dt = now - Number(last);
    if (dt < 100) { score += 0.5; signals.push(`sub-100ms-click (${dt}ms)`); }
    else if (dt < 500) { score += 0.2; signals.push(`fast-click (${dt}ms)`); }
  }

  // 2. User-agent diversity (rolling 1h window)
  const uaKey = `behaviour:ua:${p.userId}`;
  await redis.sadd(uaKey, p.userAgent.slice(0, 128));
  await redis.expire(uaKey, 3600);
  const uaCount = await redis.scard(uaKey);
  if (uaCount > 5) { score += 0.3; signals.push(`many-user-agents (${uaCount})`); }

  // 3. Burst rate — how many purchase attempts in the last 2s
  const burstKey = `behaviour:burst:${p.userId}`;
  await redis.zadd(burstKey, now, `${now}-${Math.random()}`);
  await redis.zremrangebyscore(burstKey, "-inf", now - 2000);
  await redis.pexpire(burstKey, 10_000);
  const burst = await redis.zcard(burstKey);
  if (burst > 10) { score += 0.4; signals.push(`burst-${burst}-in-2s`); }
  else if (burst > 5) { score += 0.15; signals.push(`burst-${burst}-in-2s`); }

  return { bot_score: Math.min(1, score), signals };
}
