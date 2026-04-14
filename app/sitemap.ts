import type { MetadataRoute } from "next";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/db";
import { env } from "@/lib/env";
import { CATEGORIES } from "@/lib/marketplace/search-params";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  "use cache";
  cacheTag("repos:list");
  cacheLife("hours");

  const base = env.NEXT_PUBLIC_SITE_URL ?? "https://vibeshelf.example";
  const db = createAnonClient();
  const { data } = await db
    .from("repos")
    .select("owner, name, updated_at")
    .eq("status", "published")
    .order("updated_at", { ascending: false })
    .limit(10000);

  const repos = (data ?? []).map((r) => ({
    url: `${base}/r/${r.owner}/${r.name}`,
    lastModified: r.updated_at,
    priority: 0.7,
  }));

  const categories = CATEGORIES.map((c) => ({
    url: `${base}/?categories=${c}`,
    lastModified: new Date().toISOString(),
    priority: 0.6,
  }));

  return [
    { url: base, lastModified: new Date().toISOString(), priority: 1.0 },
    ...categories,
    ...repos,
  ];
}
