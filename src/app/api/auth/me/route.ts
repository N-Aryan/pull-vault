import { NextRequest } from "next/server";
import { pool } from "@/lib/db";
import { ok, fail, requireUser } from "@/lib/api-helpers";

export async function GET(req: NextRequest) {
  const { error, userId } = await requireUser(req);
  if (error) return error;
  const { rows } = await pool.query(
    `SELECT id, email, balance_available, balance_held, created_at FROM users WHERE id = $1`,
    [userId],
  );
  if (rows.length === 0) return fail("not found", 404);
  return ok(rows[0]);
}
