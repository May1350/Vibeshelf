// proxy.ts
// Next.js 16 proxy (formerly middleware). We deliberately do NOT use
// next-intl's createMiddleware: with localePrefix: "never" and a flat
// route tree (no app/[locale]/), it still rewrites `/` to `/<locale>`
// internally and 404s. Locale resolution happens server-side in
// lib/i18n/request.ts via cookies() + headers().
//
// This proxy's only job: on first visit (no NEXT_LOCALE cookie),
// detect the preferred locale from Accept-Language and set the cookie
// so subsequent server renders are stable.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { routing } from "./lib/i18n/routing";

export default function proxy(request: NextRequest) {
  const response = NextResponse.next();
  if (!request.cookies.get("NEXT_LOCALE")) {
    const accept = request.headers.get("accept-language") ?? "";
    const candidate = accept.split(",")[0]?.split("-")[0]?.toLowerCase() ?? "";
    const locale = (routing.locales as readonly string[]).includes(candidate)
      ? candidate
      : routing.defaultLocale;
    response.cookies.set("NEXT_LOCALE", locale, {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return response;
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
