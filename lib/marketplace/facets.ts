// Cached facet aggregation for the marketplace filter sidebar.
// Zero-arg cached function (Real R1.R4) — Cache Components key is stable
// across filter changes, invalidated only by cron's revalidateTag.

import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/db";

export interface MarketplaceFacets {
  categories: Record<string, number>;
  tags: Array<{ slug: string; label: string; count: number }>;
  vibecoding: Record<string, number>;
  score_buckets: { min_3?: number; min_4?: number; min_4_5?: number };
}

export async function getMarketplaceFacets(): Promise<MarketplaceFacets> {
  "use cache";
  cacheTag("repos:facets");
  cacheLife("hours");

  const db = createAnonClient();
  // biome-ignore lint/suspicious/noExplicitAny: RPC types regen pending
  const dbAny = db as any;
  const { data, error } = await dbAny.rpc("get_marketplace_facets");
  if (error) throw new Error(`getMarketplaceFacets failed: ${error.message}`);

  const raw = (data as Record<string, Record<string, number>>) ?? {};
  return {
    categories: raw.category ?? {},
    tags: Object.entries(raw.tag ?? {})
      .map(([slug, count]) => ({ slug, label: humanizeTagSlug(slug), count }))
      .sort((a, b) => b.count - a.count),
    vibecoding: raw.vibecoding ?? {},
    score_buckets: {
      min_3: raw.score_bucket?.min_3 ?? 0,
      min_4: raw.score_bucket?.min_4 ?? 0,
      min_4_5: raw.score_bucket?.min_4_5 ?? 0,
    },
  };
}

function humanizeTagSlug(slug: string): string {
  return slug
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
