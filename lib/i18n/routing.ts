// lib/i18n/routing.ts
// next-intl locale setup. Korean-first per Q-10; detect-via-header means
// no URL prefix (existing `/`, `/r/...` paths unchanged). See spec §6.2.

import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["ko", "en"],
  defaultLocale: "ko",
  localePrefix: "never", // no /ko/ or /en/ URL prefix
});
