import { describe, expect, it } from "vitest";
import { extractReadmeSections } from "@/lib/pipeline/extractors/readme-sections";

describe("extractReadmeSections", () => {
  it("returns empty structured=false for empty input", () => {
    const r = extractReadmeSections("");
    expect(r.content).toBe("");
    expect(r.structured).toBe(false);
  });

  it("extracts Features + Getting Started sections", () => {
    const md = `
# Repo Name

Tagline here.

## Features

- Feature 1
- Feature 2

## Getting Started

Run npm install.

## License

MIT.
`.trim();
    const r = extractReadmeSections(md);
    expect(r.structured).toBe(true);
    expect(r.content).toContain("Features");
    expect(r.content).toContain("Getting Started");
    expect(r.content).not.toContain("MIT"); // License section dropped
  });

  it("falls back to first 8000 chars when no target headings", () => {
    const md = "## Random Heading\n\nNo target sections here.";
    const r = extractReadmeSections(md);
    expect(r.structured).toBe(false);
    expect(r.content.startsWith("## Random Heading")).toBe(true);
  });

  it("caps output at FALLBACK_LIMIT", () => {
    const md = `## Usage\n\n${"x".repeat(20000)}`;
    const r = extractReadmeSections(md);
    expect(r.content.length).toBeLessThanOrEqual(8000);
  });
});
