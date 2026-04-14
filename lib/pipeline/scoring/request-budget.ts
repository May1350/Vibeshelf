// Domain-specific kill-switch for scoring. Tracks Gemini call count and
// cumulative USD cost against per-run limits. Job loop checks canProceed()
// before each call and halts cleanly on exhaustion.

export interface BudgetLimits {
  readonly maxCalls: number;
  readonly maxCostUsd: number;
}

export interface BudgetState {
  readonly calls: number;
  readonly costUsd: number;
  readonly exhausted: boolean;
}

// Flash-Lite pricing (2026-04, per 1M tokens)
const INPUT_COST_PER_TOKEN = 0.1e-6;
const OUTPUT_COST_PER_TOKEN = 0.4e-6;

export class RequestBudget {
  private _calls = 0;
  private _costUsd = 0;

  constructor(private readonly limits: BudgetLimits) {}

  recordCall(inputTokens: number, outputTokens: number): void {
    this._calls += 1;
    this._costUsd += inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN;
  }

  canProceed(): boolean {
    return this._calls < this.limits.maxCalls && this._costUsd < this.limits.maxCostUsd;
  }

  state(): BudgetState {
    return {
      calls: this._calls,
      costUsd: this._costUsd,
      exhausted: !this.canProceed(),
    };
  }
}
