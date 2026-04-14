// Splits LLM-emitted feature tag arrays into:
//   - canonical: slugs present in the seed enum (linked to tags table)
//   - freeform: novel slugs (stored in repos.tags_freeform for monitoring)
//
// Also normalizes slugs: lowercase + non-alnum → '_'. Caps freeform at 20
// entries to match the DB CHECK constraint.

import { isSeedFeatureTag } from "./seed-feature-tags";

const MAX_FREEFORM_TAGS = 20;

export interface NormalizedTags {
  canonical: string[];
  freeform: string[];
}

export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function normalizeTags(
  canonicalInput: readonly string[],
  noveltyInput: readonly string[],
): NormalizedTags {
  const seen = new Set<string>();
  const canonical: string[] = [];
  const freeform: string[] = [];

  // LLM may emit canonical slugs in the novelty array or vice versa.
  // Merge both and re-classify.
  for (const raw of [...canonicalInput, ...noveltyInput]) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const slug = normalizeSlug(raw);
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    if (isSeedFeatureTag(slug)) {
      canonical.push(slug);
    } else {
      if (freeform.length < MAX_FREEFORM_TAGS) {
        freeform.push(slug);
      }
    }
  }

  return { canonical, freeform };
}
