import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./lib/i18n/request.ts");

const nextConfig: NextConfig = {
  cacheComponents: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "raw.githubusercontent.com" },
      { protocol: "https", hostname: "user-images.githubusercontent.com" },
      { protocol: "https", hostname: "github.com" },
      // NOT camo.githubusercontent.com — it's an open proxy. SP#4.5 mirror
      // will handle camo URLs by downloading + storing in Supabase Storage.
      // Dev wildcard: README images come from arbitrary hosts (project
      // websites, screenshots, badges). For production we'll mirror these
      // through Supabase Storage; until then, allow all https sources so
      // the marketplace doesn't break on real content.
      { protocol: "https", hostname: "**" },
    ],
    formats: ["image/avif", "image/webp"],
  },
};

export default withNextIntl(nextConfig);
