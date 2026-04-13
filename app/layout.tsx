import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "VibeShelf",
  description: "Curated open-source template marketplace for vibe coders",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
      </body>
    </html>
  )
}
