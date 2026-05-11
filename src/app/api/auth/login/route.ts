import { NextRequest } from "next/server";
import { z } from "zod";
import { pool } from "@/lib/db";
import { verifyPassword, setSession } from "@/lib/auth";
import { ok, fail } from "@/lib/api-helpers";

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("invalid input", 400);
  const { email, password } = parsed.data;
  const r = await pool.query(`SELECT id, password_hash FROM users WHERE email = $1`, [email]);
  if (r.rows.length === 0) return fail("invalid credentials", 401);
  const okPw = await verifyPassword(password, r.rows[0].password_hash);
  if (!okPw) return fail("invalid credentials", 401);
  await setSession(r.rows[0].id);
  return ok({ id: r.rows[0].id });
}
