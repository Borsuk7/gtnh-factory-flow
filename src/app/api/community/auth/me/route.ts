import { NextResponse } from "next/server";
import { getSessionUser, isCommunityConfigured } from "@/lib/server/community";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isCommunityConfigured()) {
    return NextResponse.json({ user: null });
  }

  try {
    const user = await getSessionUser(request);
    return NextResponse.json(
      { user: user ? { username: user.username, isAdmin: user.is_admin } : null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Not "signed out": the client asks again rather than showing Sign in.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Account lookup failed." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
