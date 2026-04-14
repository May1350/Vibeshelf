import { describe, expect, it } from "vitest";
import { MarketplaceParams, parseMarketplaceParams } from "@/lib/marketplace/search-params";

describe("parseMarketplaceParams", () => {
  it("returns defaults for empty input", () => {
    const r = parseMarketplaceParams({});
    expect(r.sort).toBe("score");
    expect(r.page).toBe(1);
    expect(r.tags).toEqual([]);
  });

  it("parses all filters", () => {
    const r = parseMarketplaceParams({
      q: "stripe",
      category: "saas",
      tags: "auth,payments",
      min_score: "4",
      vibecoding: "cursor",
      sort: "recent",
      page: "2",
    });
    expect(r.q).toBe("stripe");
    expect(r.category).toBe("saas");
    expect(r.tags).toEqual(["auth", "payments"]);
    expect(r.min_score).toBe(4);
    expect(r.vibecoding).toBe("cursor");
    expect(r.sort).toBe("recent");
    expect(r.page).toBe(2);
  });

  it("filters empty tag CSV entries", () => {
    const r = parseMarketplaceParams({ tags: ",auth,,payments," });
    expect(r.tags).toEqual(["auth", "payments"]);
  });

  it("trims and length-limits q", () => {
    const r = parseMarketplaceParams({ q: "  hello  " });
    expect(r.q).toBe("hello");

    // q at exactly 100 chars
    const long = "x".repeat(100);
    const r2 = parseMarketplaceParams({ q: long });
    expect(r2.q).toBe(long);
  });

  it("rejects q over 100 chars (falls back to defaults)", () => {
    const r = parseMarketplaceParams({ q: "x".repeat(101) });
    expect(r.q).toBeUndefined();
  });

  it("rejects invalid category enum (falls back to defaults)", () => {
    const r = parseMarketplaceParams({ category: "not_a_category" });
    expect(r.category).toBeUndefined();
  });

  it("coerces page to int min 1", () => {
    const r1 = parseMarketplaceParams({ page: "0" });
    expect(r1.page).toBe(1); // fallback
    const r2 = parseMarketplaceParams({ page: "5" });
    expect(r2.page).toBe(5);
  });

  it("handles array values (takes first)", () => {
    const r = parseMarketplaceParams({ category: ["saas", "blog"] });
    expect(r.category).toBe("saas");
  });

  it("MarketplaceParams schema accepts undefined optional fields", () => {
    const r = MarketplaceParams.parse({});
    expect(r.tags).toEqual([]);
  });
});
