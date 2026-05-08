import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { Suspense } from "react";
import { HtmlLangSync } from "@/components/i18n/html-lang-sync";
import { routing } from "@/lib/i18n/routing";
import "./globals.css";

export const metadata: Metadata = {
  title: "VibeShelf",
  description: "Curated open-source template marketplace for vibe coders",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // <html lang> needs the active locale to match the rendered content for a11y
  // and SEO. Resolving it on the root would force the whole tree dynamic
  // (cacheComponents-incompatible — see I18nProvider note below). Instead, set
  // lang to the default and let a Suspense'd async sibling overwrite the
  // attribute on the document element from inside the dynamic subtree.
  return (
    <html lang={routing.defaultLocale} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        {/* getLocale()/getMessages() read cookies+headers (uncached dynamic
            data). With cacheComponents: true, any page that reads that data
            outside a Suspense boundary becomes fully dynamic — including
            /_not-found, which then fails to prerender. Wrapping the i18n
            provider in Suspense opts only the i18n subtree out of the
            static shell. */}
        <Suspense fallback={null}>
          <I18nProvider>{children}</I18nProvider>
        </Suspense>
      </body>
    </html>
  );
}

async function I18nProvider({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <HtmlLangSync locale={locale} />
      {children}
    </NextIntlClientProvider>
  );
}
