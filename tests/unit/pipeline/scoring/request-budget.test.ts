import { describe, expect, it } from "vitest";
import { RequestBudget } from "@/lib/pipeline/scoring/request-budget";

describe("RequestBudget", () => {
  it("allows calls within budget", () => {
    const b = new RequestBudget({ maxCalls: 10, maxCostUsd: 1 });
    expect(b.canProceed()).toBe(true);
    b.recordCall(1000, 200);
    expect(b.canProceed()).toBe(true);
  });

  it("stops at maxCalls", () => {
    const b = new RequestBudget({ maxCalls: 2, maxCostUsd: 100 });
    b.recordCall(1000, 200);
    b.recordCall(1000, 200);
    expect(b.canProceed()).toBe(false);
    expect(b.state().exhausted).toBe(true);
  });

  it("stops at maxCostUsd", () => {
    const b = new RequestBudget({ maxCalls: 1000, maxCostUsd: 0.0001 });
    b.recordCall(1000, 200); // ~$0.0001 + $0.00008 = $0.00018
    expect(b.canProceed()).toBe(false);
  });

  it("state reports accurate call count and cost", () => {
    const b = new RequestBudget({ maxCalls: 10, maxCostUsd: 1 });
    b.recordCall(1000, 200);
    b.recordCall(2000, 400);
    const state = b.state();
    expect(state.calls).toBe(2);
    expect(state.costUsd).toBeCloseTo(
      1000 * 0.1e-6 + 200 * 0.4e-6 + 2000 * 0.1e-6 + 400 * 0.4e-6,
      9,
    );
  });
});
