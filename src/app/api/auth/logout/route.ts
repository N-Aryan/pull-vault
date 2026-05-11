import { NextRequest, NextResponse } from "next/server";
import { clearSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  await clearSession();
  // 303 forces the browser to GET / so the form submit works without showing JSON.
  return NextResponse.redirect(new URL("/", req.url), 303);
}
