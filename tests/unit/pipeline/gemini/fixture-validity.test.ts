// Fixture schema drift check. When prompt version bumps (new axes, enum
// changes), the LLM-side fixtures must be updated in lockstep. This test
// fails loudly if `happy.json` or `schema-semantic-garbage.json` stops
// satisfying the shape that scoreRepo's parseLlmResponse expects.

import { describe, expect, it } from "vitest";
import happy from "@/tests/fixtures/gemini-responses/happy.json";
import semanticGarbage from "@/tests/fixtures/gemini-responses/schema-semantic-garbage.json";
import { buildScoringPrompt } from "@/lib/pipeline/gemini/scoring-prompt";

describe("Gemini response fixtures validate against current schema", () => {
  it("happy.json has all required fields", () => {
    expect(happy).toHaveProperty("documentation.value");
    expect(happy).toHaveProperty("code_health_readme.value");
    expect(happy).toHaveProperty("category");
    expect(happy).toHaveProperty("feature_tags_canonical");
    expect(happy).toHaveProperty("evidence_strength");
    expect(typeof happy.documentation.value).toBe("number");
    expect(Number.isInteger(happy.documentation.value)).toBe(true);
  });

  it("schema-semantic-garbage.json flags weak evidence", () => {
    expect(semanticGarbage).toHaveProperty("evidence_strength");
    expect(semanticGarbage.evidence_strength).toBe("weak");
  });

  it("happy.json category is within current schema enum", () => {
    const prompt = buildScoringPrompt({
      owner: "x",
      name: "y",
      description: null,
      stars: 0,
      lastCommitIso: "2026-04-14T00:00:00Z",
      license: null,
      techStackSlugs: [],
      vibecodingToolSlugs: [],
      hasReadme: false,
      hasPackageJson: false,
      readmeSections: "",
    });
    const schema = prompt.responseSchema as {
      properties: { category: { enum: string[] } };
    };
    expect(schema.properties.category.enum).toContain(happy.category);
  });
});
