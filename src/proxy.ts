import { type NextRequest, NextResponse } from "next/server";

const PRIVATE = ["/assistant", "/wallet", "/markets", "/trading", "/vault", "/agent", "/guardrails", "/activity"];

// Optimistic gate on cookie presence only; every API route still verifies the session itself.
export function proxy(request: NextRequest) {
  const signedIn = request.cookies.has("mint_session");
  const { pathname } = request.nextUrl;
  const isPrivate = PRIVATE.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (isPrivate && !signedIn) return NextResponse.redirect(new URL("/login", request.url));
  if (pathname === "/login" && signedIn) return NextResponse.redirect(new URL("/assistant", request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/assistant", "/wallet/:path*", "/markets", "/trading/:path*", "/vault", "/agent", "/guardrails", "/activity", "/login"],
};
