import { describe, expect, it } from "vitest";
import { normalizeSlug, normalizeTags } from "@/lib/pipeline/scoring/tag-normalizer";

describe("normalizeSlug", () => {
  it("lowercases", () => {
    expect(normalizeSlug("Auth")).toBe("auth");
  });
  it("replaces non-alnum with _", () => {
    expect(normalizeSlug("dark-mode")).toBe("dark_mode");
    expect(normalizeSlug("AI/ML")).toBe("ai_ml");
  });
  it("trims leading/trailing underscores", () => {
    expect(normalizeSlug("-foo-")).toBe("foo");
  });
});

describe("normalizeTags", () => {
  it("splits canonical vs freeform", () => {
    const r = normalizeTags(["auth", "my_custom"], ["dark_mode", "weird-thing"]);
    expect(r.canonical.sort()).toEqual(["auth", "dark_mode"]);
    expect(r.freeform.sort()).toEqual(["my_custom", "weird_thing"]);
  });

  it("dedupes across inputs", () => {
    const r = normalizeTags(["auth", "auth"], ["auth"]);
    expect(r.canonical).toEqual(["auth"]);
    expect(r.freeform).toEqual([]);
  });

  it("normalizes variants to canonical (dark-mode → dark_mode)", () => {
    const r = normalizeTags([], ["dark-mode", "Dark Mode"]);
    expect(r.canonical).toEqual(["dark_mode"]);
  });

  it("caps freeform at 20", () => {
    const novelty = Array.from({ length: 30 }, (_, i) => `novel_${i}`);
    const r = normalizeTags([], novelty);
    expect(r.freeform.length).toBe(20);
  });

  it("handles empty + non-string inputs", () => {
    // @ts-expect-error intentional bad input
    const r = normalizeTags(["", null, undefined, "auth"], []);
    expect(r.canonical).toEqual(["auth"]);
  });
});
