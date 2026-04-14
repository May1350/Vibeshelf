import { describe, expect, it } from "vitest";
import { extractVibecodingCompat } from "@/lib/pipeline/extractors/vibecoding-compat";

describe("extractVibecodingCompat", () => {
  it("returns empty array for empty input", () => {
    expect(extractVibecodingCompat([])).toEqual([]);
  });

  it("detects cursor from legacy .cursorrules file", () => {
    const tags = extractVibecodingCompat([{ path: ".cursorrules", type: "file" }]);
    expect(tags.map((t) => t.slug)).toContain("cursor");
  });

  it("detects cursor from new-convention .cursor root directory", () => {
    const tags = extractVibecodingCompat([{ path: ".cursor", type: "dir" }]);
    expect(tags.map((t) => t.slug)).toContain("cursor");
  });

  it("does NOT match .cursorrules-template (segment match, not substring)", () => {
    const tags = extractVibecodingCompat([{ path: ".cursorrules-template", type: "file" }]);
    expect(tags.map((t) => t.slug)).not.toContain("cursor");
  });

  it("does NOT match foocursorrules (segment match, not substring)", () => {
    const tags = extractVibecodingCompat([{ path: "foocursorrules", type: "file" }]);
    expect(tags.map((t) => t.slug)).not.toContain("cursor");
  });

  it("detects bolt from .bolt directory", () => {
    const tags = extractVibecodingCompat([{ path: ".bolt", type: "dir" }]);
    expect(tags.map((t) => t.slug)).toContain("bolt");
  });

  it("detects bolt from bolt.config.json file", () => {
    const tags = extractVibecodingCompat([{ path: "bolt.config.json", type: "file" }]);
    expect(tags.map((t) => t.slug)).toContain("bolt");
  });

  it("detects lovable from .lovable file", () => {
    const tags = extractVibecodingCompat([{ path: ".lovable", type: "file" }]);
    expect(tags.map((t) => t.slug)).toContain("lovable");
  });

  it("detects lovable from lovable.config.ts file", () => {
    const tags = extractVibecodingCompat([{ path: "lovable.config.ts", type: "file" }]);
    expect(tags.map((t) => t.slug)).toContain("lovable");
  });

  it("detects replit from .replit file", () => {
    const tags = extractVibecodingCompat([{ path: ".replit", type: "file" }]);
    expect(tags.map((t) => t.slug)).toContain("replit");
  });

  it("emits tags with kind 'vibecoding_tool' and confidence 1.0", () => {
    const tags = extractVibecodingCompat([
      { path: ".cursorrules", type: "file" },
      { path: ".replit", type: "file" },
    ]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag.kind).toBe("vibecoding_tool");
      expect(tag.confidence).toBe(1.0);
    }
  });

  it("normalises Windows backslash paths (.\\.cursorrules)", () => {
    const tags = extractVibecodingCompat([{ path: ".\\.cursorrules", type: "file" }]);
    expect(tags.map((t) => t.slug)).toContain("cursor");
  });

  it("returns unique tags when both .cursorrules and .cursor dir are present", () => {
    const tags = extractVibecodingCompat([
      { path: ".cursorrules", type: "file" },
      { path: ".cursor", type: "dir" },
    ]);
    const cursorTags = tags.filter((t) => t.slug === "cursor");
    expect(cursorTags).toHaveLength(1);
  });

  it("detects multiple independent tools simultaneously", () => {
    const tags = extractVibecodingCompat([
      { path: ".cursorrules", type: "file" },
      { path: ".replit", type: "file" },
      { path: "bolt.config.js", type: "file" },
      { path: ".lovable", type: "file" },
    ]);
    const slugs = tags.map((t) => t.slug).sort();
    expect(slugs).toEqual(["bolt", "cursor", "lovable", "replit"]);
  });

  it("ignores malformed entries (missing path)", () => {
    const tags = extractVibecodingCompat([
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed for test
      { type: "file" } as any,
      { path: ".cursorrules", type: "file" },
    ]);
    expect(tags.map((t) => t.slug)).toContain("cursor");
  });
});
