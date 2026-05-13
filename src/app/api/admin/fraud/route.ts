import { pool } from "@/lib/db";
import { ok } from "@/lib/api-helpers";

export async function GET() {
  // Rate-limit-event breakdown
  const rl = await pool.query(
    `SELECT outcome, endpoint, COUNT(*)::int AS n
       FROM rate_limit_events
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY outcome, endpoint ORDER BY n DESC`,
  );

  // Flagged accounts
  const flagged = await pool.query(
    `SELECT id, email, bot_score, flagged_reason, flagged_at
       FROM users WHERE flagged_at IS NOT NULL ORDER BY bot_score DESC LIMIT 50`,
  );

  // Wash-trade flags
  const wash = await pool.query(
    `SELECT id, related_kind, related_id, reason, severity,
            user_a, user_b, flagged_at
       FROM wash_trade_flags WHERE resolved_at IS NULL
       ORDER BY severity DESC, flagged_at DESC LIMIT 100`,
  );

  // Top noisy IPs in the last 24h
  const ips = await pool.query(
    `SELECT ip, COUNT(*)::int AS attempts
       FROM rate_limit_events
      WHERE created_at > NOW() - INTERVAL '24 hours' AND ip IS NOT NULL
      GROUP BY ip ORDER BY attempts DESC LIMIT 20`,
  );

  return ok({
    rate_limit_24h: rl.rows,
    flagged_accounts: flagged.rows,
    wash_trade_flags: wash.rows,
    noisy_ips: ips.rows,
  });
}
