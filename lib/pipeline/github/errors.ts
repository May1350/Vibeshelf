// Error taxonomy for GitHub API calls. Each class carries enough
// context for the caller to decide retry vs. skip vs. abort.
//
// Design notes:
//   - We prefer distinct classes over a single GitHubError with a
//     `kind` field so callers can `catch (e instanceof RateLimitError)`
//     cleanly and TS narrows the type inside the block.
//   - `status` is the HTTP status. For non-HTTP errors (network, retry
//     exhaustion) it's undefined.
//   - `path` is the GitHub API path the call was made to — included on
//     every class because log aggregators need it to group failures.

export class GitHubAPIError extends Error {
  readonly status?: number;
  readonly path: string;

  constructor(message: string, path: string, status?: number) {
    super(message);
    this.name = this.constructor.name;
    this.path = path;
    this.status = status;
  }
}

/** 401 — token revoked or invalid. Caller should disable the token. */
export class TokenRevokedError extends GitHubAPIError {}

/**
 * 403 with `X-RateLimit-Remaining: 0`. Token is fine; budget is
 * exhausted. Caller can sleep until reset_at or rotate to another
 * token. Do NOT disable the token.
 */
export class RateLimitError extends GitHubAPIError {
  readonly resetAt: Date | null;

  constructor(message: string, path: string, resetAt: Date | null) {
    super(message, path, 403);
    this.resetAt = resetAt;
  }
}

/**
 * Thrown when every enabled token in the pool is exhausted AND we have
 * no known reset time to wait for. Job should fail-fast.
 */
export class RateLimitExhaustedError extends GitHubAPIError {
  constructor(path: string) {
    super("GitHub token pool exhausted with no known reset time", path);
  }
}

/**
 * Thrown when the pool is exhausted and the next reset is too far away
 * to wait inline (>60s — the caller would blow the function's time
 * budget). No HTTP call was made, so there's no status. The job loop
 * should batch-retry later rather than sleeping.
 */
export class PoolExhaustedError extends GitHubAPIError {
  readonly resetAt: Date;

  constructor(path: string, resetAt: Date) {
    super(`GitHub pool exhausted; next reset at ${resetAt.toISOString()}`, path);
    this.resetAt = resetAt;
  }
}

/**
 * 403 with remaining > 0 — usually a permission/scope issue (private
 * repo, org SSO, etc.) rather than rate limiting. Caller should skip
 * the resource, not retry.
 */
export class PermissionError extends GitHubAPIError {
  constructor(message: string, path: string) {
    super(message, path, 403);
  }
}

/** 404 — resource does not exist (or is private and we can't see it). */
export class NotFoundError extends GitHubAPIError {
  constructor(path: string) {
    super(`GitHub 404: ${path}`, path, 404);
  }
}

/**
 * 451 — DMCA takedown / legally restricted. Skip the repo and mark it
 * for exclusion upstream.
 */
export class LegallyUnavailableError extends GitHubAPIError {
  constructor(path: string) {
    super(`GitHub 451 (legally unavailable): ${path}`, path, 451);
  }
}

/** 422 — malformed query (usually the search API). */
export class ValidationError extends GitHubAPIError {
  constructor(message: string, path: string) {
    super(`GitHub 422: ${message}`, path, 422);
  }
}

/** 5xx after all retries exhausted. */
export class ServerError extends GitHubAPIError {
  constructor(path: string, status: number) {
    super(`GitHub ${status} after retries: ${path}`, path, status);
  }
}
