// Canonical feature-tag enum. Source of truth for:
//   - Gemini responseSchema (feature_tags_canonical items.enum)
//   - Tag normalizer (what's "canonical" vs "freeform")
//   - DB migration 20260415000004_seed_feature_tags.sql (mirrored list)
//
// When adding/removing a slug, update the migration too. CI snippet
// validation catches divergence between this file and the DB state.

export const SEED_FEATURE_TAG_SLUGS = [
  "auth",
  "social_login",
  "magic_link",
  "payments",
  "stripe",
  "subscription",
  "dark_mode",
  "responsive",
  "animation",
  "ai_integration",
  "chatbot",
  "rag",
  "database_included",
  "realtime",
  "docker",
  "ci_cd",
  "self_hostable",
  "mdx",
  "cms",
  "blog_content",
  "email",
  "transactional_email",
  "analytics",
  "seo",
  "sitemap",
  "i18n",
  "rtl",
  "file_upload",
  "search",
  "notifications",
] as const;

export type SeedFeatureTagSlug = (typeof SEED_FEATURE_TAG_SLUGS)[number];

export function isSeedFeatureTag(slug: string): slug is SeedFeatureTagSlug {
  return (SEED_FEATURE_TAG_SLUGS as readonly string[]).includes(slug);
}
