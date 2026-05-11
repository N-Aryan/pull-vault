import { Pool, PoolClient } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

export const pool: Pool =
  global.__pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
  });

if (!global.__pgPool) global.__pgPool = pool;

/**
 * Run a function inside a transaction. Rolls back on throw, commits on return.
 * Uses SERIALIZABLE by default for the high-stakes paths (pack purchase, trade,
 * bid). Caller may pass "READ COMMITTED" for read-heavy work.
 */
export async function withTx<T>(
  fn: (client: PoolClient) => Promise<T>,
  isolation: "SERIALIZABLE" | "READ COMMITTED" = "READ COMMITTED",
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Re-runs a transaction up to N times if Postgres throws a serialization
 * failure (40001) or deadlock (40P01). Crucial for SERIALIZABLE workloads
 * because correct apps must retry on transient conflicts.
 */
export async function withTxRetry<T>(
  fn: (client: PoolClient) => Promise<T>,
  isolation: "SERIALIZABLE" | "READ COMMITTED" = "SERIALIZABLE",
  maxAttempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await withTx(fn, isolation);
    } catch (e: any) {
      lastErr = e;
      if (e?.code === "40001" || e?.code === "40P01") {
        const backoff = 5 * Math.pow(2, i) + Math.random() * 5;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
