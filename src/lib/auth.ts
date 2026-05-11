import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";

const enc = new TextEncoder();
const secret = () => enc.encode(process.env.JWT_SECRET || "dev-only-not-secure");

export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export async function issueToken(userId: string) {
  return await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret());
}

export async function verifyToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return (payload.sub as string) ?? null;
  } catch {
    return null;
  }
}

const COOKIE = "pv_token";

export async function setSession(userId: string) {
  const token = await issueToken(userId);
  cookies().set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSession() {
  cookies().delete(COOKIE);
}

export async function currentUserId(): Promise<string | null> {
  const t = cookies().get(COOKIE)?.value;
  if (!t) return null;
  return verifyToken(t);
}

export async function userIdFromRequest(req: NextRequest): Promise<string | null> {
  const t = req.cookies.get(COOKIE)?.value;
  if (!t) return null;
  return verifyToken(t);
}

export async function userIdFromAuthHeader(header?: string | null): Promise<string | null> {
  if (!header?.startsWith("Bearer ")) return null;
  return verifyToken(header.slice(7));
}
