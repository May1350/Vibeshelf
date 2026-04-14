import { describe, expect, it } from "vitest";
import { extractTechStack } from "@/lib/pipeline/extractors/tech-stack";

describe("extractTechStack", () => {
  it("returns empty array for null input", () => {
    expect(extractTechStack(null)).toEqual([]);
  });

  it("returns empty array for malformed JSON (doesn't throw)", () => {
    expect(() => extractTechStack("{ not valid json")).not.toThrow();
    expect(extractTechStack("{ not valid json")).toEqual([]);
  });

  it("returns empty array when parsed value is not an object", () => {
    expect(extractTechStack("42")).toEqual([]);
    expect(extractTechStack('"a string"')).toEqual([]);
    expect(extractTechStack("[1,2,3]")).toEqual([]);
  });

  it("detects nextjs from dependencies.next", () => {
    const pkg = JSON.stringify({ dependencies: { next: "^14.0.0" } });
    const tags = extractTechStack(pkg);
    expect(tags.map((t) => t.slug)).toContain("nextjs");
  });

  it("detects supabase from @supabase/supabase-js", () => {
    const pkg = JSON.stringify({ dependencies: { "@supabase/supabase-js": "^2.0.0" } });
    expect(extractTechStack(pkg).map((t) => t.slug)).toContain("supabase");
  });

  it("detects supabase from @supabase/ssr", () => {
    const pkg = JSON.stringify({ dependencies: { "@supabase/ssr": "^0.5.0" } });
    expect(extractTechStack(pkg).map((t) => t.slug)).toContain("supabase");
  });

  it("detects tags from devDependencies (typescript)", () => {
    const pkg = JSON.stringify({ devDependencies: { typescript: "^5.0.0" } });
    expect(extractTechStack(pkg).map((t) => t.slug)).toContain("typescript");
  });

  it("detects tags from BOTH dependencies and devDependencies", () => {
    const pkg = JSON.stringify({
      dependencies: { next: "^14.0.0" },
      devDependencies: { typescript: "^5.0.0", vite: "^5.0.0" },
    });
    const slugs = extractTechStack(pkg).map((t) => t.slug);
    expect(slugs).toContain("nextjs");
    expect(slugs).toContain("typescript");
    expect(slugs).toContain("vite");
  });

  it("dedupes when two packages map to the same slug (supabase)", () => {
    const pkg = JSON.stringify({
      dependencies: {
        "@supabase/supabase-js": "^2.0.0",
        "@supabase/ssr": "^0.5.0",
      },
    });
    const tags = extractTechStack(pkg);
    const supabaseTags = tags.filter((t) => t.slug === "supabase");
    expect(supabaseTags).toHaveLength(1);
  });

  it("dedupes when a package appears in both deps and devDeps", () => {
    const pkg = JSON.stringify({
      dependencies: { react: "^19.0.0" },
      devDependencies: { react: "^19.0.0" },
    });
    const tags = extractTechStack(pkg);
    const reactTags = tags.filter((t) => t.slug === "react");
    expect(reactTags).toHaveLength(1);
  });

  it("emits tags with kind 'tech_stack' and confidence within (0, 1]", () => {
    const pkg = JSON.stringify({
      dependencies: { next: "^14", tailwindcss: "^3" },
    });
    const tags = extractTechStack(pkg);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag.kind).toBe("tech_stack");
      expect(tag.confidence).toBeGreaterThan(0);
      expect(tag.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("ignores unknown package names", () => {
    const pkg = JSON.stringify({
      dependencies: { "some-random-package": "^1.0.0", next: "^14.0.0" },
    });
    const slugs = extractTechStack(pkg).map((t) => t.slug);
    expect(slugs).toEqual(["nextjs"]);
  });
});
