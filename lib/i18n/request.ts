// lib/i18n/request.ts
// next-intl config: read Accept-Language header + optional ?lang cookie
// to pick the locale; default to Korean.

import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const hdrs = await headers();
  const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
  const headerLocale = hdrs.get("accept-language")?.split(",")[0]?.split("-")[0];
  const candidate = cookieLocale ?? headerLocale ?? routing.defaultLocale;
  const locale = (routing.locales as readonly string[]).includes(candidate)
    ? candidate
    : routing.defaultLocale;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
