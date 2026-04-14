// GitHub token pool — DB-backed rotation of PATs / App-installation tokens.
//
// Invariants (see plan + dep-cruiser F4):
//   - This module NEVER imports createServiceClient. The caller hands us
//     `db: SupabaseClient` so the "one client per run" rule is preserved.
//   - Token decryption happens here in TS (not in SQL) because the
//     AES-256-GCM key lives in TOKEN_ENCRYPTION_KEY_V1. The RPC
//     acquire_github_token returns encrypted bytes; we decrypt.
//   - acquire/release must be used as a pair; disableToken is reserved
//     for tokens GitHub has permanently refused (401 revoked, persistent
//     403 non-rate-limit).
//
// Concurrency model:
//   acquire_github_token uses `FOR UPDATE SKIP LOCKED` inside a
//   transaction-scoped row lock. Because supabase-js HTTP calls are
//   stateless, the row lock is released the instant the RPC returns —
//   so "holding" a token is an app-level contract: between acquireToken
//   and releaseToken, no other call will SELECT this row because we
//   immediately `UPDATE ... last_used_at=now()` on release. In practice
//   the budget tracking via `remaining` is what prevents concurrent
//   over-spend; SKIP LOCKED only prevents two parallel acquires from
//   racing on the same ORDER BY winner in the same millisecond.

import { decryptToken } from "@/lib/crypto/tokens";
import type { SupabaseClient } from "@/lib/db";
import { rpcAcquireGithubToken } from "./db-rpc";

export type TokenScope = "search" | "rest" | "graphql";

export interface AcquiredToken {
  id: string;
  token: string;
  remaining: number | null;
}

/**
 * Pick the best-available token for `scope`. Returns null when the pool
 * is exhausted (all tokens disabled or `remaining=0`). Caller should
 * then call waitForNextReset to decide whether to sleep or throw.
 */
export async function acquireToken(
  db: SupabaseClient,
  scope: TokenScope,
): Promise<AcquiredToken | null> {
  const { data, error } = await rpcAcquireGithubToken(db, scope);

  if (error) {
    throw new Error(`token-pool: acquire_github_token RPC failed: ${error.message}`);
  }

  // RPC returns an array (table-returning function); empty = pool exhausted.
  const rows = data ?? [];

  const row = rows[0];
  if (!row) return null;

  // bytea comes back from PostgREST as a `\x<hex>` string. Decode to Buffer
  // before passing to decryptToken. Guard against unexpected shapes so we
  // fail loud instead of silently feeding garbage to AES-GCM.
  const encrypted = decodeBytea(row.token_encrypted);
  const plaintext = decryptToken(encrypted, row.token_key_version);

  return {
    id: row.id,
    token: plaintext,
    remaining: row.remaining,
  };
}

/**
 * Record the rate-limit state GitHub returned after a call. Always call
 * this after a successful fetch, even on 4xx — the remaining budget
 * still decremented.
 *
 * NOTE: resetAt is only written when non-null. A null resetAt means the
 * response omitted the X-RateLimit-Reset header — in that case we keep
 * whatever value was already stored rather than clobbering a known-good
 * reset time with null (which would make the token invisible to
 * waitForNextReset).
 */
export async function releaseToken(
  db: SupabaseClient,
  id: string,
  remaining: number,
  resetAt: Date | null,
): Promise<void> {
  const patch: Record<string, unknown> = {
    remaining,
    last_used_at: new Date().toISOString(),
  };
  if (resetAt) {
    patch.reset_at = resetAt.toISOString();
  }

  const { error } = await db.from("github_tokens").update(patch).eq("id", id);

  if (error) {
    throw new Error(`token-pool: releaseToken failed for ${id}: ${error.message}`);
  }
}

/**
 * Find the earliest `reset_at` among enabled tokens for the scope.
 * Caller (client.ts) decides whether to sleep until then or give up.
 * Returns null if no enabled token has a known reset_at (i.e. fresh
 * tokens that have never been used, or everything disabled).
 */
export async function waitForNextReset(
  db: SupabaseClient,
  scope: TokenScope,
): Promise<Date | null> {
  const { data, error } = await db
    .from("github_tokens")
    .select("reset_at")
    .eq("scope", scope)
    .is("disabled_at", null)
    .not("reset_at", "is", null)
    .order("reset_at", { ascending: true })
    .limit(1);

  if (error) {
    throw new Error(`token-pool: waitForNextReset query failed: ${error.message}`);
  }

  const row = data?.[0];
  if (!row?.reset_at) return null;
  return new Date(row.reset_at);
}

/**
 * Permanently disable a token. Use when GitHub returns 401 (revoked) or
 * a persistent 403 that is not rate-limit-related. Rate-limit
 * exhaustion is NOT a reason to disable — the token will self-heal at
 * reset_at.
 */
export async function disableToken(db: SupabaseClient, id: string, reason: string): Promise<void> {
  const { error } = await db
    .from("github_tokens")
    .update({ disabled_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    throw new Error(`token-pool: disableToken failed for ${id}: ${error.message}`);
  }

  // Structured log for ops; no PII in `reason` — callers pass short codes
  // like "http_401" / "http_403_permission".
  console.warn(`[token-pool] disabled token ${id}: ${reason}`);
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

/**
 * PostgREST returns `bytea` as either:
 *   (a) a `\x<hex>` string (default "hex" bytea_output), or
 *   (b) a base64 string if the column was selected through a view with
 *       a different encoding.
 * Our github_tokens.token_encrypted is column-level bytea, so (a) is
 * what we expect. We still handle base64 defensively.
 */
function decodeBytea(value: string): Buffer {
  if (value.startsWith("\\x")) {
    return Buffer.from(value.slice(2), "hex");
  }
  return Buffer.from(value, "base64");
}
