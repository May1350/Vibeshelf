import { describe, expect, it } from "vitest";
import { computeDeterministicScores } from "@/lib/pipeline/scoring/deterministic";

function baseInput(overrides = {}) {
  return {
    stars: 100,
    forks: 10,
    watchers: 5,
    githubCreatedAt: new Date("2024-04-14T00:00:00Z"), // 2 years old
    lastCommitAt: new Date("2026-02-14T00:00:00Z"), // 2 months ago
    capabilities: { has_package_json: true, has_readme: true },
    fileTree: [
      { path: "package.json", type: "file" as const },
      { path: "tests/foo.test.ts", type: "file" as const },
    ],
    packageJsonContent: JSON.stringify({
      dependencies: { react: "19", next: "16", tailwindcss: "4", zod: "4" },
      devDependencies: { typescript: "5", vitest: "4", eslint: "9" },
    }),
    repoAssetCount: { gif: 1, image: 2 },
    assetsExtractedAt: new Date("2026-04-13T00:00:00Z"),
    ...overrides,
  };
}

describe("computeDeterministicScores — popularity", () => {
  it("scores 0 for brand-new repo with 0 stars", () => {
    const r = computeDeterministicScores(
      baseInput({
        stars: 0,
        githubCreatedAt: new Date("2026-04-13T00:00:00Z"),
      }),
    );
    expect(r.popularity_score).toBe(0);
  });

  it("scores > 0 for old repo with many stars", () => {
    const r = computeDeterministicScores(
      baseInput({
        stars: 10000,
        githubCreatedAt: new Date("2020-01-01T00:00:00Z"),
      }),
    );
    expect(r.popularity_score).toBeGreaterThan(2);
    expect(r.popularity_score).toBeLessThanOrEqual(5);
  });

  it("caps at 5 even for massive star counts", () => {
    const r = computeDeterministicScores(baseInput({ stars: 10_000_000 }));
    expect(r.popularity_score).toBeLessThanOrEqual(5);
  });

  it("handles months=0 (created today)", () => {
    const r = computeDeterministicScores(
      baseInput({
        stars: 100,
        githubCreatedAt: new Date(),
      }),
    );
    expect(Number.isFinite(r.popularity_score)).toBe(true);
  });
});

describe("computeDeterministicScores — maintenance", () => {
  it("5 for recent commit (within 6 months)", () => {
    const r = computeDeterministicScores(
      baseInput({
        lastCommitAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days
      }),
    );
    expect(r.maintenance_score).toBe(5);
  });

  it("3 for 9 months old", () => {
    const r = computeDeterministicScores(
      baseInput({
        lastCommitAt: new Date(Date.now() - 270 * 24 * 60 * 60 * 1000),
      }),
    );
    expect(r.maintenance_score).toBe(3);
  });

  it("1 for 2 years old", () => {
    const r = computeDeterministicScores(
      baseInput({
        lastCommitAt: new Date(Date.now() - 600 * 24 * 60 * 60 * 1000),
      }),
    );
    expect(r.maintenance_score).toBe(1);
  });

  it("0 for 3+ years old", () => {
    const r = computeDeterministicScores(
      baseInput({
        lastCommitAt: new Date(Date.now() - 1200 * 24 * 60 * 60 * 1000),
      }),
    );
    expect(r.maintenance_score).toBe(0);
  });
});

describe("computeDeterministicScores — code_health (deterministic)", () => {
  it("rewards tests presence", () => {
    const r1 = computeDeterministicScores(
      baseInput({ fileTree: [{ path: "package.json", type: "file" }] }),
    );
    const r2 = computeDeterministicScores(baseInput()); // has tests/
    expect(r2.code_health_score_deterministic).toBeGreaterThan(r1.code_health_score_deterministic);
  });

  it("rewards reasonable dep count", () => {
    const r = computeDeterministicScores(baseInput());
    expect(r.code_health_score_deterministic).toBeGreaterThanOrEqual(4);
  });

  it("handles malformed package.json without throwing", () => {
    const r = computeDeterministicScores(baseInput({ packageJsonContent: "not json" }));
    expect(Number.isFinite(r.code_health_score_deterministic)).toBe(true);
  });
});

describe("computeDeterministicScores — visual_preview", () => {
  it("5 when any GIF present", () => {
    const r = computeDeterministicScores(baseInput({ repoAssetCount: { gif: 1, image: 0 } }));
    expect(r.visual_preview_score).toBe(5);
  });

  it("4 with 3+ images, no GIF", () => {
    const r = computeDeterministicScores(baseInput({ repoAssetCount: { gif: 0, image: 3 } }));
    expect(r.visual_preview_score).toBe(4);
  });

  it("3 with 1-2 images", () => {
    const r = computeDeterministicScores(baseInput({ repoAssetCount: { gif: 0, image: 1 } }));
    expect(r.visual_preview_score).toBe(3);
  });

  it("0 with no assets AND extraction attempted", () => {
    const r = computeDeterministicScores(baseInput({ repoAssetCount: { gif: 0, image: 0 } }));
    expect(r.visual_preview_score).toBe(0);
  });

  it("2.5 (neutral) when assetsExtractedAt is null (extraction not attempted)", () => {
    const r = computeDeterministicScores(
      baseInput({
        assetsExtractedAt: null,
        repoAssetCount: { gif: 0, image: 0 },
      }),
    );
    expect(r.visual_preview_score).toBe(2.5);
  });
});
