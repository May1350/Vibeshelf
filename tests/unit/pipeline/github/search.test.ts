import { describe, expect, it } from "vitest";
import { ALLOWED_LICENSES } from "@/lib/pipeline/github/license-allowlist";
import {
  buildDailySearchBatch,
  buildSearchQueryString,
  SEARCH_KEYWORDS,
} from "@/lib/pipeline/github/search";

describe("buildSearchQueryString", () => {
  it("emits all query fragments: keyword, license, stars, pushed", () => {
    const q = buildSearchQueryString({
      keyword: "template",
      license: "mit",
      minStars: 10,
      pushedAfter: new Date("2026-01-01T00:00:00Z"),
    });
    expect(q).toContain("template");
    expect(q).toContain("license:mit");
    expect(q).toContain("stars:>=10");
    expect(q).toContain("pushed:>=2026-01-01");
  });

  it("formats the pushedAfter date as YYYY-MM-DD (no time component)", () => {
    const q = buildSearchQueryString({
      keyword: "starter-kit",
      license: "apache-2.0",
      minStars: 50,
      pushedAfter: new Date("2025-06-15T12:34:56Z"),
    });
    expect(q).toContain("pushed:>=2025-06-15");
    expect(q).not.toContain("T");
    expect(q).not.toContain("12:34");
  });
});

describe("SEARCH_KEYWORDS", () => {
  it("has at least 10 keywords", () => {
    expect(SEARCH_KEYWORDS.length).toBeGreaterThanOrEqual(10);
  });

  it("has unique entries", () => {
    const set = new Set(SEARCH_KEYWORDS);
    expect(set.size).toBe(SEARCH_KEYWORDS.length);
  });
});

describe("buildDailySearchBatch", () => {
  const pushedAfter = new Date("2026-01-01T00:00:00Z");

  it("has length equal to SEARCH_KEYWORDS.length × ALLOWED_LICENSES.size", () => {
    const batch = buildDailySearchBatch(pushedAfter);
    expect(batch.length).toBe(SEARCH_KEYWORDS.length * ALLOWED_LICENSES.size);
  });

  it("every element's pushedAfter equals the input date", () => {
    const batch = buildDailySearchBatch(pushedAfter);
    for (const q of batch) {
      expect(q.pushedAfter.getTime()).toBe(pushedAfter.getTime());
    }
  });

  it("every element's license is in ALLOWED_LICENSES", () => {
    const batch = buildDailySearchBatch(pushedAfter);
    for (const q of batch) {
      expect(ALLOWED_LICENSES.has(q.license)).toBe(true);
    }
  });

  it("every element's keyword is in SEARCH_KEYWORDS", () => {
    const batch = buildDailySearchBatch(pushedAfter);
    const keywordSet = new Set<string>(SEARCH_KEYWORDS);
    for (const q of batch) {
      expect(keywordSet.has(q.keyword)).toBe(true);
    }
  });

  it("covers the full cross-product (every keyword × license pair appears exactly once)", () => {
    const batch = buildDailySearchBatch(pushedAfter);
    const pairs = new Set(batch.map((q) => `${q.keyword}::${q.license}`));
    expect(pairs.size).toBe(SEARCH_KEYWORDS.length * ALLOWED_LICENSES.size);
  });

  it("applies a sensible minStars default (> 0)", () => {
    const batch = buildDailySearchBatch(pushedAfter);
    for (const q of batch) {
      expect(q.minStars).toBeGreaterThan(0);
    }
  });
});
