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

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORIES);

export const MarketplaceParams = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  // CSV of category slugs → string[]; unknown values are dropped silently
  // (resilience to URL hand-edits). Empty array = no category filter.
  categories: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(",")
            .map((c) => c.trim())
            .filter((c) => CATEGORY_SET.has(c))
        : [],
    ),
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

// Multi-value params: the form submits checkboxes as repeated query params
// (?categories=saas&categories=ai_tool), but URL-builders (buildHref / chips)
// emit CSV (?categories=saas,ai_tool). Normalize both into a single CSV string
// before zod parsing.
const MULTI_VALUE_KEYS = new Set(["categories", "tags"]);

/**
 * Parse Next.js searchParams (Promise<...> in Next 16 — caller must await).
 * Falls back to defaults on parse failure for resilience to malformed URLs.
 */
export function parseMarketplaceParams(
  input: Record<string, string | string[] | undefined>,
): MarketplaceQuery {
  const flattened: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (MULTI_VALUE_KEYS.has(k)) {
      // Join repeated form-submit values into the same CSV the parser expects.
      flattened[k] = Array.isArray(v) ? v.filter(Boolean).join(",") : v;
    } else {
      flattened[k] = Array.isArray(v) ? (v[0] ?? "") : v;
    }
  }
  const result = MarketplaceParams.safeParse(flattened);
  if (!result.success) {
    // Return defaults on parse failure
    return MarketplaceParams.parse({});
  }
  return result.data;
}
