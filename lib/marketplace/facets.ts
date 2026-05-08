// Query-aware facet aggregation for the marketplace filter sidebar.
//
// Each facet axis is computed with all OTHER active filters applied — a
// classic "what would this candidate filter narrow to" presentation. The
// cache key is therefore the full query (Cache Components derives it from
// the function arguments). Cron's `revalidateTag('repos:facets')` busts
// every variant on data change.

import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/db";
import { tagLabel } from "./labels";
import type { MarketplaceQuery } from "./search-params";

export interface MarketplaceFacets {
  categories: Record<string, number>;
  tags: Array<{ slug: string; label: string; count: number }>;
  vibecoding: Record<string, number>;
  score_buckets: { min_3?: number; min_4?: number; min_4_5?: number };
}

export async function getMarketplaceFacets(query: MarketplaceQuery): Promise<MarketplaceFacets> {
  "use cache";
  cacheTag("repos:facets");
  cacheLife("hours");

  const db = createAnonClient();
  // biome-ignore lint/suspicious/noExplicitAny: RPC types regen pending
  const dbAny = db as any;
  const { data, error } = await dbAny.rpc("get_marketplace_facets_v2", {
    p_q: query.q ?? null,
    p_categories: query.categories.length > 0 ? query.categories : null,
    p_tags: query.tags.length > 0 ? query.tags : null,
    p_min_score: query.min_score ?? null,
    p_vibecoding: query.vibecoding ?? null,
  });
  if (error) throw new Error(`getMarketplaceFacets failed: ${error.message}`);

  const raw = (data as Record<string, Record<string, number>>) ?? {};
  return {
    categories: raw.category ?? {},
    tags: Object.entries(raw.tag ?? {})
      .map(([slug, count]) => ({ slug, label: tagLabel(slug), count }))
      .sort((a, b) => b.count - a.count),
    vibecoding: raw.vibecoding ?? {},
    score_buckets: {
      min_3: raw.score_bucket?.min_3 ?? 0,
      min_4: raw.score_bucket?.min_4 ?? 0,
      min_4_5: raw.score_bucket?.min_4_5 ?? 0,
    },
  };
}
