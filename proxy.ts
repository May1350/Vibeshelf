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

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { routing } from "./lib/i18n/routing";

const LOCALE_COOKIE_OPTS = {
  path: "/",
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 24 * 365,
};

export default function proxy(request: NextRequest) {
  // /ko, /en, /ko/anything, /en/anything → strip the prefix and redirect.
  // localePrefix is "never", so prefixed URLs would otherwise 404. We honour
  // the requested locale by setting NEXT_LOCALE before the redirect lands.
  const { pathname, search } = request.nextUrl;
  for (const loc of routing.locales) {
    const exact = `/${loc}`;
    if (pathname === exact || pathname.startsWith(`${exact}/`)) {
      const stripped = pathname.slice(exact.length) || "/";
      const target = new URL(`${stripped}${search}`, request.url);
      const redirect = NextResponse.redirect(target, 308);
      redirect.cookies.set("NEXT_LOCALE", loc, LOCALE_COOKIE_OPTS);
      return redirect;
    }
  }

  const response = NextResponse.next();
  if (!request.cookies.get("NEXT_LOCALE")) {
    const accept = request.headers.get("accept-language") ?? "";
    const candidate = accept.split(",")[0]?.split("-")[0]?.toLowerCase() ?? "";
    const locale = (routing.locales as readonly string[]).includes(candidate)
      ? candidate
      : routing.defaultLocale;
    response.cookies.set("NEXT_LOCALE", locale, LOCALE_COOKIE_OPTS);
  }
  return response;
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
