import { NextResponse, type NextRequest } from "next/server";
import { LINE_HEADER, LINE_PARAM, lineParam, pinnedLine } from "@/lib/domain/lines";

// Optimistic gate (Next 16 proxy — no DB here): no session cookie means
// straight to /login. Real validation happens server-side in lib/server/auth.
//
// It also hands the page the product line its address names (`?line=LV`) as
// a request header, which lib/server/line.ts reads. A server action posts to
// the page's own address, so it gets the same line. The header is always set
// here or dropped — never one the browser sent. A screen pinned to one line
// (PINNED_LINE) always gets its own, and an address naming the other is sent
// to the right one, the rest of it kept.
export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  if (pathname === "/login") return NextResponse.next();
  if (!request.cookies.get("atc_session")?.value) {
    const login = new URL("/login", request.url);
    return NextResponse.redirect(login);
  }
  const pinned = pinnedLine(pathname);
  const asked = lineParam(searchParams.get(LINE_PARAM));
  if (pinned && asked && asked !== pinned && request.method === "GET") {
    const to = request.nextUrl.clone();
    to.searchParams.set(LINE_PARAM, pinned);
    return NextResponse.redirect(to);
  }
  const headers = new Headers(request.headers);
  const line = pinned ?? asked;
  if (line) headers.set(LINE_HEADER, line);
  else headers.delete(LINE_HEADER);
  const res = NextResponse.next({ request: { headers } });
  // the line used to be a cookie set by a switch in the top bar — gone now
  if (request.cookies.has("line")) res.cookies.delete("line");
  return res;
}

export const config = {
  // everything except static assets and Next internals — and the automations'
  // tick, which the database's scheduler calls with its own secret (no
  // session); the route itself checks the secret, or a session for a page's tick
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|brand/|icons/|manifest.webmanifest|notify-sw.js|api/automations/tick).*)"],
};
