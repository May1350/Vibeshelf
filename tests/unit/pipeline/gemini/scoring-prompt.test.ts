import { describe, expect, it } from "vitest";
import { buildScoringPrompt, SCORING_PROMPT_VERSION } from "@/lib/pipeline/gemini/scoring-prompt";
import { SEED_FEATURE_TAG_SLUGS } from "@/lib/pipeline/scoring/seed-feature-tags";

// The schema shape is fully typed as `object` on the public API; tests need
// structural access. Narrowing via this helper keeps biome's no-explicit-any
// rule happy while still letting tests inspect the JSON-schema tree.
type SchemaShape = {
  properties: {
    documentation: { required: string[] };
    category: { enum: string[] };
    feature_tags_canonical: { items: { enum: string[] } };
  };
};
const asSchema = (x: unknown) => x as SchemaShape;

const FIXTURE = {
  owner: "vercel",
  name: "next.js",
  description: "The React Framework",
  stars: 100000,
  lastCommitIso: "2026-04-10T00:00:00Z",
  license: "mit",
  techStackSlugs: ["nextjs", "react", "typescript"],
  vibecodingToolSlugs: ["cursor"],
  hasReadme: true,
  hasPackageJson: true,
  readmeSections: "## Features\n\n- Fast\n\n## Getting Started\n\nnpm install",
};

describe("buildScoringPrompt", () => {
  it("returns version matching exported constant", () => {
    const r = buildScoringPrompt(FIXTURE);
    expect(r.version).toBe(SCORING_PROMPT_VERSION);
  });

  it("system prompt mentions vibe coders", () => {
    const r = buildScoringPrompt(FIXTURE);
    expect(r.systemPrompt).toContain("바이브코더");
  });

  it("user prompt includes all metadata fields", () => {
    const r = buildScoringPrompt(FIXTURE);
    expect(r.userPrompt).toContain("vercel/next.js");
    expect(r.userPrompt).toContain("The React Framework");
    expect(r.userPrompt).toContain("100000");
    expect(r.userPrompt).toContain("cursor");
    expect(r.userPrompt).toContain("Features");
    expect(r.userPrompt).toContain("Getting Started");
  });

  it("responseSchema has value before rationale in each axis", () => {
    const r = buildScoringPrompt(FIXTURE);
    const schema = asSchema(r.responseSchema);
    const docRequired = schema.properties.documentation.required;
    expect(docRequired.indexOf("value")).toBeLessThan(docRequired.indexOf("rationale"));
  });

  it("responseSchema includes all 12 categories", () => {
    const r = buildScoringPrompt(FIXTURE);
    const categories = asSchema(r.responseSchema).properties.category.enum;
    expect(categories).toHaveLength(12);
    expect(categories).toContain("portfolio");
    expect(categories).toContain("chatbot");
  });

  it("feature_tags_canonical enum matches SEED_FEATURE_TAG_SLUGS", () => {
    const r = buildScoringPrompt(FIXTURE);
    const enumSlugs = asSchema(r.responseSchema).properties.feature_tags_canonical.items.enum;
    expect(enumSlugs.sort()).toEqual([...SEED_FEATURE_TAG_SLUGS].sort());
  });

  it("handles hasReadme=false path (no README section)", () => {
    const r = buildScoringPrompt({ ...FIXTURE, hasReadme: false, readmeSections: "" });
    expect(r.userPrompt).toContain("README 본문 없음");
  });
});
