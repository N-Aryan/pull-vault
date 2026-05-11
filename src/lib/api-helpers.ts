import { NextRequest, NextResponse } from "next/server";
import { userIdFromRequest } from "@/lib/auth";

export async function requireUser(req: NextRequest) {
  const userId = await userIdFromRequest(req);
  if (!userId) {
    return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }), userId: null as null };
  }
  return { error: null, userId };
}

export function ok<T>(data: T, init?: number) {
  return NextResponse.json(data, { status: init ?? 200 });
}
export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}
