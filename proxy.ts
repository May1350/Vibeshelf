// proxy.ts
// next-intl proxy (formerly middleware, renamed in Next.js 16): reads
// accept-language + NEXT_LOCALE cookie, sets the locale on the request.
// No URL rewriting (localePrefix: never).

import createMiddleware from "next-intl/middleware";
import { routing } from "./lib/i18n/routing";

export default createMiddleware(routing);

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
