// Thin fetch wrapper around api.github.com that:
//   1) pulls a token from the pool,
//   2) injects the Authorization header,
//   3) tracks rate-limit headers and writes them back to the pool,
//   4) classifies 4xx/5xx into typed errors,
//   5) retries 5xx with bounded exponential backoff.
//
// The client is framework-free (no next/* or react/* imports) per
// dep-cruiser rule `no-pipeline-imports-*`. All DB access is via the
// SupabaseClient the caller hands in — this module does NOT create
// service clients of its own.

import type { SupabaseClient } from "@/lib/db";
import {
  LegallyUnavailableError,
  NotFoundError,
  PermissionError,
  PoolExhaustedError,
  RateLimitError,
  RateLimitExhaustedError,
  ServerError,
  TokenRevokedError,
  ValidationError,
} from "./errors";
import type { TokenScope } from "./token-pool";
import { acquireToken, disableToken, releaseToken, waitForNextReset } from "./token-pool";

export interface GithubFetchOptions extends RequestInit {
  /** Which pool scope to draw from. Default: "rest". */
  scope?: TokenScope;
}

export interface GithubFetchResult {
  data: unknown;
  status: number;
  headers: Headers;
}

const API_BASE = "https://api.github.com";
const USER_AGENT = "VibeShelf-Ingestion";
const ACCEPT = "application/vnd.github+json";

// Backoff schedule for 5xx: 500ms, then 2s. Two retries, so a total of
// three attempts before ServerError is thrown. Values chosen to stay
// well within a Vercel 300s function budget even under sustained flake.
const BACKOFF_MS = [500, 2000];

export async function githubFetch(
  path: string,
  options: GithubFetchOptions,
  db: SupabaseClient,
): Promise<GithubFetchResult> {
  const scope: TokenScope = options.scope ?? "rest";

  // ──────────────────────────────────────────────────────────────────
  // 1) Acquire a token. If the pool is empty, peek at the next reset.
  //    We don't actually sleep here — the caller owns the event loop
  //    and may prefer to fail-fast or batch other work. We sleep only
  //    when a reset is imminent (≤ 60s). Anything longer → throw.
  // ──────────────────────────────────────────────────────────────────
  let token = await acquireToken(db, scope);
  if (!token) {
    const reset = await waitForNextReset(db, scope);
    if (!reset) throw new RateLimitExhaustedError(path);

    const waitMs = reset.getTime() - Date.now() + 5000; // 5s safety buffer
    if (waitMs > 60_000) {
      // >60s wait means this call site should yield. Surface a typed
      // error (distinct from RateLimitError which implies an HTTP 403
      // was observed) so callers can handle batch-retry vs immediate
      // retry differently.
      throw new PoolExhaustedError(path, reset);
    }

    await sleep(Math.max(waitMs, 0));
    token = await acquireToken(db, scope);
    if (!token) throw new RateLimitExhaustedError(path);
  }

  // ──────────────────────────────────────────────────────────────────
  // 2) Perform the call with 5xx retry.
  // ──────────────────────────────────────────────────────────────────
  const url = path.startsWith("http") ? path : API_BASE + path;
  const headers = new Headers(options.headers);
  headers.set("Authorization", `token ${token.token}`);
  headers.set("User-Agent", USER_AGENT);
  headers.set("Accept", ACCEPT);

  let lastStatus = 0;
  let response: Response | null = null;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    response = await fetch(url, { ...options, headers });
    lastStatus = response.status;

    if (response.status < 500) break;
    const delay = BACKOFF_MS[attempt];
    if (delay !== undefined) {
      await sleep(delay);
    }
  }

  if (!response) {
    // Should be unreachable — fetch throws on network errors, doesn't
    // return undefined — but TS doesn't know that.
    throw new ServerError(path, lastStatus);
  }

  // ──────────────────────────────────────────────────────────────────
  // 3) Update the pool with the rate-limit state GitHub returned.
  //    We always do this, even on error, because the budget ticked
  //    down regardless of whether our call succeeded.
  // ──────────────────────────────────────────────────────────────────
  const remainingHeader = response.headers.get("X-RateLimit-Remaining");
  const resetHeader = response.headers.get("X-RateLimit-Reset");
  const remaining = remainingHeader === null ? 0 : Number.parseInt(remainingHeader, 10);
  const resetAt = resetHeader ? new Date(Number.parseInt(resetHeader, 10) * 1000) : null;

  // Always release so remaining/reset_at/last_used_at reflect reality,
  // even on 401 where we'll also disable the token below. releaseToken
  // only writes these three fields; disableToken only sets disabled_at,
  // so the two UPDATEs compose safely.
  await releaseToken(db, token.id, Number.isFinite(remaining) ? remaining : 0, resetAt);

  // ──────────────────────────────────────────────────────────────────
  // 4) Classify response.
  // ──────────────────────────────────────────────────────────────────
  if (response.status >= 200 && response.status < 300) {
    const data = await safeJson(response);
    return { data, status: response.status, headers: response.headers };
  }

  if (response.status === 401) {
    await disableToken(db, token.id, "http_401_token_revoked");
    throw new TokenRevokedError(`GitHub 401 on ${path}`, path, 401);
  }

  if (response.status === 403) {
    // Distinguish rate-limit 403 from permission 403 by the header.
    // GitHub sometimes also sets X-RateLimit-Remaining: 0 for secondary
    // rate limits (abuse detection) — treat those as rate-limit too.
    if (remainingHeader === "0" || remaining === 0) {
      throw new RateLimitError(`GitHub 403 rate-limited on ${path}`, path, resetAt);
    }
    throw new PermissionError(`GitHub 403 permission denied on ${path}`, path);
  }

  if (response.status === 404) throw new NotFoundError(path);
  if (response.status === 451) throw new LegallyUnavailableError(path);
  if (response.status === 422) {
    const body = await safeJson(response);
    const msg =
      isRecord(body) && typeof body.message === "string" ? body.message : "validation error";
    throw new ValidationError(msg, path);
  }

  if (response.status >= 500) throw new ServerError(path, response.status);

  // Any other 4xx: surface as a generic non-retryable server error with
  // the real status so the caller can inspect it.
  throw new ServerError(path, response.status);
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJson(response: Response): Promise<unknown> {
  // Some endpoints (204 No Content, or 304 Not Modified on conditional
  // requests) return no body. Guard against JSON.parse('').
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
