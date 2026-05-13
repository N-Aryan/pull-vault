import { redis } from "@/lib/redis";
import { pool } from "@/lib/db";

/**
 * Sliding-window log rate limiter — atomic via Redis Lua.
 * ───────────────────────────────────────────────────────
 *
 * STORAGE
 *   For each (subject, endpoint) bucket we maintain a Redis Sorted Set:
 *     key   = "rl:{subject}:{endpoint}"
 *     score = unix-epoch-ms of each request
 *     value = a unique token (epoch-ms + random) so two requests at the
 *             exact same ms can both be recorded
 *
 * CHECK + REGISTER (atomic via Lua):
 *   1. ZREMRANGEBYSCORE  key  -inf  (now - window_ms)
 *   2. ZCARD              key
 *   3. if (count >= limit) → return {0, count, ttl}
 *   4. ZADD key now token
 *   5. PEXPIRE key window_ms
 *   6. return {1, count + 1, 0}
 *
 *   The whole script runs in one Redis "step" — there is NO interleaving
 *   between the count check and the registration. 100 requests racing
 *   produce *exactly* `limit` allowed and the rest rejected.
 *
 * WHY SORTED SET, NOT TOKEN BUCKET:
 *   The brief calls out "sliding window log, not a naive counter". Token
 *   bucket is fine for throughput shaping but blurs the boundary between
 *   "10 requests in 5s ago and 0 now" vs "0 then and 10 now" — they both
 *   leave the bucket empty. With a sorted-set log we know the exact
 *   timestamps and can answer "limit per 60s" with strict semantics.
 */

const SLIDING_WINDOW_LUA = `
local key       = KEYS[1]
local now_ms    = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit     = tonumber(ARGV[3])
local token     = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now_ms - window_ms)
local count = redis.call('ZCARD', key)
if count >= limit then
  -- Earliest entry still in window — tells caller when it's safe to retry.
  local earliest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_at = tonumber(earliest[2]) + window_ms
  return {0, count, retry_at}
end

redis.call('ZADD', key, now_ms, token)
redis.call('PEXPIRE', key, window_ms)
return {1, count + 1, 0}
`;

export interface RateLimitRule {
  /** Human-readable name for logging. */
  name: string;
  /** Window length in milliseconds. */
  window_ms: number;
  /** Max requests within the window. */
  limit: number;
}

export interface RateLimitOutcome {
  allowed: boolean;
  count: number;
  retry_at_ms: number;
  rule: string;
}

export async function check(
  subject: string,
  endpoint: string,
  rule: RateLimitRule,
): Promise<RateLimitOutcome> {
  const key = `rl:${subject}:${endpoint}:${rule.name}`;
  const now = Date.now();
  const token = `${now}-${Math.random().toString(36).slice(2)}`;
  const res = (await redis.eval(
    SLIDING_WINDOW_LUA,
    1,
    key,
    String(now),
    String(rule.window_ms),
    String(rule.limit),
    token,
  )) as [number, number, number];
  return {
    allowed: res[0] === 1,
    count: res[1],
    retry_at_ms: res[2],
    rule: rule.name,
  };
}

/**
 * Default rule registry. Tuned for the trial — explained in ARCHITECTURE.md.
 *
 * Pack purchases: 5 per minute is plenty for a human (read description,
 * click). A scripted bot trying to drain inventory would hit 100/s. We cap
 * at 5/min PER USER (the per-user limit) and 30/min PER IP (the IP limit,
 * which catches multi-account abuse from one machine).
 *
 * Auctions: bidding is faster-paced — 30 bids/min is fine for active
 * humans; bots placing 50 micro-bids in 1s get capped.
 */
export const RULES = {
  packBuyPerUser: { name: "pack_buy_user",   window_ms: 60_000, limit: 5 },
  packBuyPerIp:   { name: "pack_buy_ip",     window_ms: 60_000, limit: 30 },
  packBuyPerDay:  { name: "pack_buy_day",    window_ms: 24 * 60 * 60_000, limit: 200 },
  bidPerUser:     { name: "bid_user",        window_ms: 60_000, limit: 30 },
  bidPerAuction:  { name: "bid_user_auction",window_ms: 10_000, limit: 3 },
  apiPerIp:       { name: "api_ip",          window_ms: 60_000, limit: 300 },
} satisfies Record<string, RateLimitRule>;

/**
 * Combined limiter — checks BOTH the user-keyed rule and the IP-keyed rule.
 * Returns the first failure if any.
 */
export async function checkPackPurchase(userId: string, ip: string): Promise<RateLimitOutcome> {
  for (const [subject, rule] of [
    [userId, RULES.packBuyPerUser],
    [ip,     RULES.packBuyPerIp],
    [userId, RULES.packBuyPerDay],
  ] as const) {
    const r = await check(subject, "buy", rule);
    if (!r.allowed) return r;
  }
  return { allowed: true, count: 0, retry_at_ms: 0, rule: "ok" };
}

/** Log a violation so the admin dashboard can show fraud trends. */
export async function logViolation(opts: {
  userId?: string | null;
  ip?: string | null;
  endpoint: string;
  outcome: "blocked" | "throttled" | "flagged";
  detail?: string;
}) {
  await pool
    .query(
      `INSERT INTO rate_limit_events (user_id, ip, endpoint, outcome, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [opts.userId ?? null, opts.ip ?? null, opts.endpoint, opts.outcome, opts.detail ?? null],
    )
    .catch((e) => console.error("logViolation", e));
}
