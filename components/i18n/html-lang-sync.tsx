"use client";

import { useEffect } from "react";

// Root layout sets <html lang> to the default locale at SSR (cacheComponents
// requires a static shell). When the active locale differs we patch the
// attribute on mount so screen readers and SEO crawlers see the right value
// after hydration.
export function HtmlLangSync({ locale }: { locale: string }) {
  useEffect(() => {
    if (document.documentElement.lang !== locale) {
      document.documentElement.lang = locale;
    }
  }, [locale]);
  return null;
}
