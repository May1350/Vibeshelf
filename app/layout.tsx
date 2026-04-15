import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { Suspense } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "VibeShelf",
  description: "Curated open-source template marketplace for vibe coders",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
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
      {children}
    </NextIntlClientProvider>
  );
}
