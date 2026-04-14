import { describe, expect, it } from "vitest";
import { isSeedFeatureTag, SEED_FEATURE_TAG_SLUGS } from "@/lib/pipeline/scoring/seed-feature-tags";

describe("seed feature tags", () => {
  it("has 30 canonical slugs", () => {
    expect(SEED_FEATURE_TAG_SLUGS.length).toBe(30);
  });

  it("all slugs are lowercase snake_case", () => {
    for (const slug of SEED_FEATURE_TAG_SLUGS) {
      expect(slug).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("has no duplicates", () => {
    const set = new Set(SEED_FEATURE_TAG_SLUGS);
    expect(set.size).toBe(SEED_FEATURE_TAG_SLUGS.length);
  });

  it("isSeedFeatureTag type-narrows correctly", () => {
    expect(isSeedFeatureTag("auth")).toBe(true);
    expect(isSeedFeatureTag("not_a_tag")).toBe(false);
  });
});
