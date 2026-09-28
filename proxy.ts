import { NextResponse, type NextRequest } from "next/server";

// Optimistic gate (Next 16 proxy — no DB here): no session cookie means
// straight to /login. Real validation happens server-side in lib/server/auth.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/login") return NextResponse.next();
  if (!request.cookies.get("atc_session")?.value) {
    const login = new URL("/login", request.url);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  // everything except static assets and Next internals
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|brand/|notify-sw.js).*)"],
};
