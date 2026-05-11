import { NextRequest } from "next/server";
import { z } from "zod";
import { pool } from "@/lib/db";
import { hashPassword, setSession } from "@/lib/auth";
import { ok, fail } from "@/lib/api-helpers";

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("invalid input", 400);

  const { email, password } = parsed.data;
  const exists = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
  if (exists.rows.length > 0) return fail("email already registered", 409);

  const hash = await hashPassword(password);
  const startingBalance = Number(process.env.DEFAULT_BALANCE_CENTS || 100000);
  const ins = await pool.query(
    `INSERT INTO users (email, password_hash, balance_available)
     VALUES ($1, $2, $3) RETURNING id`,
    [email, hash, startingBalance],
  );
  await setSession(ins.rows[0].id);
  return ok({ id: ins.rows[0].id, balance_available: startingBalance });
}
