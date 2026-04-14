import { describe, expect, it } from "vitest";
import { scoreTier } from "@/lib/marketplace/score-tier";

describe("scoreTier", () => {
  it("returns Excellent for >= 4.5", () => {
    expect(scoreTier(4.5)).toBe("Excellent");
    expect(scoreTier(5.0)).toBe("Excellent");
  });
  it("returns Good for [3.5, 4.5)", () => {
    expect(scoreTier(3.5)).toBe("Good");
    expect(scoreTier(4.49)).toBe("Good");
  });
  it("returns Fair for [2.5, 3.5)", () => {
    expect(scoreTier(2.5)).toBe("Fair");
    expect(scoreTier(3.49)).toBe("Fair");
  });
  it("returns Limited for < 2.5", () => {
    expect(scoreTier(0)).toBe("Limited");
    expect(scoreTier(2.49)).toBe("Limited");
  });
});
