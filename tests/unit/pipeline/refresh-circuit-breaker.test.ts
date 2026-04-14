// Unit test for the refreshJob removal-ratio circuit breaker.
// Confirms the ExcessiveRemovalError class contract; the integration
// test harness exercises the actual trip path.
//
// The breaker itself is tested indirectly because refreshJob depends
// on a live DB + mocked GitHub pool. A focused trip test belongs in
// tests/integration/pipeline/refresh-circuit-breaker.test.ts (deferred
// until the refreshJob integration suite is stable — Issue #5).

import { describe, expect, it } from "vitest";
import { ExcessiveRemovalError } from "@/lib/pipeline/jobs/refresh";

describe("ExcessiveRemovalError", () => {
  it("carries the removed/processed/threshold fields", () => {
    const err = new ExcessiveRemovalError(5, 20, 0.1);
    expect(err.removed).toBe(5);
    expect(err.processed).toBe(20);
    expect(err.threshold).toBe(0.1);
    expect(err.name).toBe("ExcessiveRemovalError");
  });

  it("message reports the percent exceeded and the threshold", () => {
    const err = new ExcessiveRemovalError(3, 20, 0.1);
    expect(err.message).toContain("removed 3/20");
    expect(err.message).toContain("15.0%");
    expect(err.message).toContain("10%");
    expect(err.message).toContain("aborting");
  });

  it("is a subclass of Error so runJob's catch writes pipeline_runs.status='failed'", () => {
    const err = new ExcessiveRemovalError(1, 10, 0.1);
    expect(err).toBeInstanceOf(Error);
  });
});
