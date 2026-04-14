// URL search-params validation for the marketplace home page.
// All filters/sort/page live in URL → shareable, SSR-friendly, browser-back works.

import { z } from "zod";

export const CATEGORIES = [
  "saas",
  "ecommerce",
  "dashboard",
  "landing_page",
  "ai_tool",
  "utility",
  "game",
  "portfolio",
  "blog",
  "chatbot",
  "mobile_app",
  "other",
] as const;

export const VIBECODING_TOOLS = ["cursor", "bolt", "lovable", "replit"] as const;
export const SORTS = ["score", "recent", "popular"] as const;

export const MarketplaceParams = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  category: z.enum(CATEGORIES).optional(),
  tags: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter(Boolean) : [])),
  min_score: z.coerce.number().min(0).max(5).optional(),
  vibecoding: z.enum(VIBECODING_TOOLS).optional(),
  sort: z.enum(SORTS).default("score"),
  page: z.coerce.number().int().min(1).default(1),
});

export type MarketplaceQuery = z.infer<typeof MarketplaceParams>;

/**
 * Parse Next.js searchParams (Promise<...> in Next 16 — caller must await).
 * Falls back to defaults on parse failure for resilience to malformed URLs.
 */
export function parseMarketplaceParams(
  input: Record<string, string | string[] | undefined>,
): MarketplaceQuery {
  // Normalize: prefer first value when array (URL params can repeat)
  const flattened: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    flattened[k] = Array.isArray(v) ? (v[0] ?? "") : v;
  }
  const result = MarketplaceParams.safeParse(flattened);
  if (!result.success) {
    // Return defaults on parse failure
    return MarketplaceParams.parse({});
  }
  return result.data;
}
