// Typed error hierarchy for Gemini API calls. Mirrors the pattern in
// lib/pipeline/github/errors.ts so score-repo can narrow via instanceof.

export class GeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** HTTP 429 — quota exhausted. Job should halt; next cron retries. */
export class GeminiRateLimitError extends GeminiError {}

/** HTTP 5xx — transient. Caller may retry inline with backoff. */
export class GeminiServerError extends GeminiError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Gemini ${status}: ${message}`);
  }
}

/** Safety/content filter tripped. Repo → needs_review. */
export class GeminiContentFilterError extends GeminiError {}

/** Response JSON did not match responseSchema. Retry once with error re-injection. */
export class SchemaValidationError extends GeminiError {
  constructor(
    message: string,
    readonly raw: unknown,
  ) {
    super(message);
  }
}

/** Response truncated (MAX_TOKENS finish reason). Retry with more output budget. */
export class TruncatedResponseError extends GeminiError {}
