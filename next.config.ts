import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "raw.githubusercontent.com" },
      { protocol: "https", hostname: "user-images.githubusercontent.com" },
      { protocol: "https", hostname: "github.com" },
      // NOT camo.githubusercontent.com — it's an open proxy. SP#4.5 mirror
      // will handle camo URLs by downloading + storing in Supabase Storage.
    ],
    formats: ["image/avif", "image/webp"],
  },
};

export default nextConfig;
